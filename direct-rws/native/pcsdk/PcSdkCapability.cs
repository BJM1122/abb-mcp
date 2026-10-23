using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace Abb.PcSdkHost
{
    internal static class PcSdkCapability
    {
        private static readonly string[] RequiredAssemblyFiles =
        {
            "ABB.Robotics.Controllers.PC.dll",
            "RobotStudio.Services.RobApi.dll",
            "RobotStudio.Services.RobApi.Desktop.dll"
        };

        public static Dictionary<string, object> Inspect(string sdkDirectory)
        {
            Dictionary<string, object> report = CreateBaseReport("capability", sdkDirectory);
            List<object> assemblies = new List<object>();
            string expectedVersion = null;
            bool filesAvailable = true;
            bool versionsMatch = true;

            for (int index = 0; index < RequiredAssemblyFiles.Length; index++)
            {
                string path = Path.Combine(sdkDirectory, RequiredAssemblyFiles[index]);
                Dictionary<string, object> assemblyInfo = InspectAssembly(path);
                assemblies.Add(assemblyInfo);

                bool exists = (bool)assemblyInfo["exists"];
                filesAvailable = filesAvailable && exists;
                if (!exists)
                {
                    continue;
                }

                string version = (string)assemblyInfo["assemblyVersion"];
                if (expectedVersion == null)
                {
                    expectedVersion = version;
                }
                else if (!String.Equals(expectedVersion, version, StringComparison.Ordinal))
                {
                    versionsMatch = false;
                }
            }

            report["assemblies"] = assemblies;
            report["sdkFilesAvailable"] = filesAvailable;
            report["sameAssemblyVersion"] = filesAvailable && versionsMatch;
            report["sdkAssemblyVersion"] = expectedVersion;

            Dictionary<string, object> api = new Dictionary<string, object>();
            bool apiReady = false;

            if (filesAvailable && versionsMatch)
            {
                try
                {
                    string controllerAssemblyPath =
                        Path.Combine(sdkDirectory, "ABB.Robotics.Controllers.PC.dll");
                    Assembly assembly = Assembly.LoadFrom(controllerAssemblyPath);
                    Type controllerType = assembly.GetType(
                        "ABB.Robotics.Controllers.Controller", true, false);
                    Type backupEventArgsType = assembly.GetType(
                        "ABB.Robotics.Controllers.BackupEventArgs", true, false);
                    Type fileSystemType = assembly.GetType(
                        "ABB.Robotics.Controllers.FileSystemDomain.FileSystem", true, false);
                    Type connectionType = assembly.GetType(
                        "ABB.Robotics.Controllers.ConnectionType", true, false);
                    Type userInfoType = assembly.GetType(
                        "ABB.Robotics.Controllers.UserInfo", true, false);

                    api["controllerBackup"] = HasMethod(
                        controllerType,
                        "Backup",
                        BindingFlags.Public | BindingFlags.Instance,
                        new Type[] { typeof(string) });
                    api["backupCompleted"] = controllerType.GetEvent(
                        "BackupCompleted",
                        BindingFlags.Public | BindingFlags.Instance) != null;
                    api["backupInProgress"] = controllerType.GetProperty(
                        "BackupInProgress",
                        BindingFlags.Public | BindingFlags.Instance) != null;
                    api["backupSucceededResult"] = backupEventArgsType.GetProperty(
                        "Succeeded",
                        BindingFlags.Public | BindingFlags.Instance) != null;
                    api["fileSystemGetDirectory"] = HasMethod(
                        fileSystemType,
                        "GetDirectory",
                        BindingFlags.Public | BindingFlags.Instance,
                        new Type[] { typeof(string), typeof(string), typeof(bool) });
                    api["connectWithCertificateValidation"] = HasMethod(
                        controllerType,
                        "Connect",
                        BindingFlags.Public | BindingFlags.Static,
                        new Type[] { typeof(Guid), connectionType, typeof(bool) });
                    api["certificateErrorEvent"] = controllerType.GetEvent(
                        "OnCertificateError",
                        BindingFlags.Public | BindingFlags.Static) != null;
                    api["logon"] = HasMethod(
                        controllerType,
                        "Logon",
                        BindingFlags.Public | BindingFlags.Instance,
                        new Type[] { userInfoType });
                    api["compiledBackupEngine"] = typeof(PcSdkBackupEngine).GetMethod(
                        "BackupAndDownload",
                        BindingFlags.Public | BindingFlags.Static) != null;
                    api["compiledConnectProbe"] = typeof(PcSdkBackupEngine).GetMethod(
                        "ConnectProbe",
                        BindingFlags.Public | BindingFlags.Static) != null;

                    apiReady =
                        (bool)api["controllerBackup"] &&
                        (bool)api["backupCompleted"] &&
                        (bool)api["backupInProgress"] &&
                        (bool)api["backupSucceededResult"] &&
                        (bool)api["fileSystemGetDirectory"] &&
                        (bool)api["connectWithCertificateValidation"] &&
                        (bool)api["certificateErrorEvent"] &&
                        (bool)api["logon"] &&
                        (bool)api["compiledBackupEngine"] &&
                        (bool)api["compiledConnectProbe"];
                }
                catch (Exception exception)
                {
                    report["apiInspectionError"] = new Dictionary<string, object>
                    {
                        { "type", exception.GetType().FullName },
                        { "message", exception.Message }
                    };
                }
            }

            report["api"] = api;
            report["apiReady"] = apiReady;
            report["backupExecutionExposed"] = true;
            report["backupInput"] = "stdin-json-only";
            report["connectProbeExposed"] = true;
            report["connectProbeInput"] = "stdin-json-only";
            report["untrustedCertificatePolicy"] = "reject";
            report["ok"] = filesAvailable && versionsMatch && apiReady;
            return report;
        }

        public static Dictionary<string, object> Probe(string sdkDirectory)
        {
            Dictionary<string, object> report = Inspect(sdkDirectory);
            report["command"] = "probe";

            List<object> checks = new List<object>();
            bool passed = (bool)report["ok"];
            checks.Add(new Dictionary<string, object>
            {
                { "name", "pc-sdk-api-surface" },
                { "passed", passed },
                { "detail", passed
                    ? "Required PC SDK assemblies and public backup/download APIs are present."
                    : "Required PC SDK files, versions, or APIs are incomplete." }
            });

            try
            {
                IList<OfflineCheck> engineChecks = PcSdkBackupEngine.RunOfflineValidation();
                for (int index = 0; index < engineChecks.Count; index++)
                {
                    OfflineCheck check = engineChecks[index];
                    checks.Add(new Dictionary<string, object>
                    {
                        { "name", check.Name },
                        { "passed", check.Passed },
                        { "detail", check.Detail }
                    });
                    passed = passed && check.Passed;
                }
            }
            catch (Exception exception)
            {
                passed = false;
                checks.Add(new Dictionary<string, object>
                {
                    { "name", "backup-engine-offline-validation" },
                    { "passed", false },
                    { "detail", exception.GetType().FullName + ": " + exception.Message }
                });
            }

            report["checks"] = checks;
            report["ok"] = passed;
            return report;
        }

        private static Dictionary<string, object> CreateBaseReport(
            string command,
            string sdkDirectory)
        {
            return new Dictionary<string, object>
            {
                { "schemaVersion", 1 },
                { "service", "abb-pcsdk-host" },
                { "version", Assembly.GetExecutingAssembly().GetName().Version.ToString() },
                { "command", command },
                { "sdkDirectory", sdkDirectory },
                { "runtime", Environment.Version.ToString() },
                { "process64Bit", Environment.Is64BitProcess },
                { "operatingSystem64Bit", Environment.Is64BitOperatingSystem },
                { "controllerAccessed", false },
                { "controllerModified", false },
                { "powershellUsed", false },
                { "limitations", new string[]
                    {
                        "This probe validates only the local PC SDK runtime and API surface.",
                        "It does not prove that a controller has option 616-1 or 3119-1.",
                        "No live IRC5 or OmniCore backup has been performed by this native host.",
                        "No live connect-probe is run by capability or probe.",
                        "The backup command is an internal transport and must be called only after external identity, plan, and approval-token validation."
                    }
                }
            };
        }

        private static Dictionary<string, object> InspectAssembly(string path)
        {
            Dictionary<string, object> info = new Dictionary<string, object>();
            info["path"] = path;
            info["exists"] = File.Exists(path);
            if (!File.Exists(path))
            {
                return info;
            }

            FileInfo file = new FileInfo(path);
            FileVersionInfo versionInfo = FileVersionInfo.GetVersionInfo(path);
            AssemblyName assemblyName = AssemblyName.GetAssemblyName(path);
            Assembly assembly = Assembly.LoadFrom(path);

            info["bytes"] = file.Length;
            info["assemblyVersion"] = assemblyName.Version.ToString();
            info["fileVersion"] = versionInfo.FileVersion;
            info["productVersion"] = versionInfo.ProductVersion;
            info["targetFramework"] = GetTargetFramework(assembly);
            info["processorArchitecture"] = assemblyName.ProcessorArchitecture.ToString();
            return info;
        }

        private static string GetTargetFramework(Assembly assembly)
        {
            IList<CustomAttributeData> attributes = assembly.GetCustomAttributesData();
            for (int index = 0; index < attributes.Count; index++)
            {
                CustomAttributeData attribute = attributes[index];
                if (attribute.AttributeType.FullName ==
                    "System.Runtime.Versioning.TargetFrameworkAttribute" &&
                    attribute.ConstructorArguments.Count > 0)
                {
                    object value = attribute.ConstructorArguments[0].Value;
                    return value == null ? null : value.ToString();
                }
            }

            return null;
        }

        private static bool HasMethod(
            Type type,
            string name,
            BindingFlags flags,
            Type[] parameterTypes)
        {
            return type.GetMethod(name, flags, null, parameterTypes, null) != null;
        }
    }
}
