using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Abb.PcSdkHost
{
    internal static class Program
    {
        private const string DefaultSdkDirectory = @"C:\ABB_PCSDK\Bin";

        private static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);

            string command = GetCommand(args);
            string sdkDirectory = GetOption(args, "--sdk-dir");
            if (String.IsNullOrWhiteSpace(sdkDirectory))
            {
                sdkDirectory = Environment.GetEnvironmentVariable("ABB_PCSDK_DIR");
            }

            if (String.IsNullOrWhiteSpace(sdkDirectory))
            {
                sdkDirectory = DefaultSdkDirectory;
            }

            try
            {
                sdkDirectory = Path.GetFullPath(sdkDirectory);
                SdkAssemblyResolver.Install(sdkDirectory);

                if (String.Equals(command, "capability", StringComparison.OrdinalIgnoreCase))
                {
                    Dictionary<string, object> capability = PcSdkCapability.Inspect(sdkDirectory);
                    WriteJson(capability);
                    return IsSuccessful(capability) ? 0 : 3;
                }

                if (String.Equals(command, "probe", StringComparison.OrdinalIgnoreCase))
                {
                    Dictionary<string, object> probe = PcSdkCapability.Probe(sdkDirectory);
                    WriteJson(probe);
                    return IsSuccessful(probe) ? 0 : 3;
                }

                if (String.Equals(command, "connect-probe", StringComparison.OrdinalIgnoreCase))
                {
                    return RunConnectProbeFromStandardInput();
                }

                if (String.Equals(command, "backup", StringComparison.OrdinalIgnoreCase))
                {
                    return RunBackupFromStandardInput();
                }

                WriteJson(CreateError(
                    "Usage",
                    "Usage: abb-pcsdk-host.exe capability|probe|connect-probe|backup " +
                    "[--sdk-dir <RobotStudio Bin directory>]. Online commands accept JSON only through redirected standard input."));
                return 2;
            }
            catch (Exception exception)
            {
                Dictionary<string, object> error = CreateError("HostFailure", exception.Message);
                error["exceptionType"] = exception.GetType().FullName;
                WriteJson(error);
                return 1;
            }
        }

        private static int RunConnectProbeFromStandardInput()
        {
            BackupCommandInput input = null;
            ConnectProbeRequest request = null;

            try
            {
                if (!Console.IsInputRedirected)
                {
                    WriteJson(CreateError(
                        "ConnectProbeStdinRequired",
                        "The connect-probe request must be supplied as JSON through redirected standard input. " +
                        "Credentials are not accepted as command-line arguments."));
                    return 2;
                }

                string json = Console.In.ReadToEnd();
                if (String.IsNullOrWhiteSpace(json))
                {
                    WriteJson(CreateError(
                        "ConnectProbeRequestEmpty",
                        "Standard input did not contain a connect-probe request."));
                    return 2;
                }

                try
                {
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = 1024 * 1024;
                    input = serializer.Deserialize<BackupCommandInput>(json);
                }
                catch (Exception exception)
                {
                    Dictionary<string, object> parseError = CreateError(
                        "ConnectProbeRequestInvalidJson",
                        "Standard input could not be parsed as a connect-probe request.");
                    parseError["exceptionType"] = exception.GetType().FullName;
                    WriteJson(parseError);
                    return 2;
                }

                Guid systemId;
                if (input == null || !Guid.TryParse(input.systemId, out systemId))
                {
                    WriteJson(CreateError(
                        "ConnectProbeRequestInvalid",
                        "systemId must be a valid GUID."));
                    return 2;
                }

                request = new ConnectProbeRequest
                {
                    SystemId = systemId,
                    ExpectedControllerName = input.expectedControllerName,
                    ExpectedRobotWare = input.expectedRobotWare,
                    UserName = input.userName,
                    Password = input.password
                };

                PcSdkBackupEngine.ValidateConnectProbeRequestOffline(request);
            }
            catch (Exception exception)
            {
                if (request != null)
                {
                    request.Password = null;
                }

                Dictionary<string, object> error = CreateError(
                    "ConnectProbeRequestInvalid",
                    exception.Message);
                error["exceptionType"] = exception.GetType().FullName;
                WriteJson(error);
                return 2;
            }
            finally
            {
                if (input != null)
                {
                    input.password = null;
                }
            }

            try
            {
                ConnectProbeResult result = PcSdkBackupEngine.ConnectProbe(request);
                Dictionary<string, object> payload = new Dictionary<string, object>
                {
                    { "ok", result.Connected && result.LoggedOn },
                    { "service", "abb-pcsdk-host" },
                    { "command", "connect-probe" },
                    { "controllerAccessAttempted", true },
                    { "controllerAccessed", result.Connected },
                    { "controllerModified", false },
                    { "backupCalled", false },
                    { "getDirectoryCalled", false },
                    { "controllerOptionStatus", "available" },
                    { "requiredControllerOption", result.RequiredControllerOption },
                    { "result", result }
                };
                WriteJson(payload);
                return result.Connected && result.LoggedOn ? 0 : 6;
            }
            catch (Exception exception)
            {
                ConnectProbeException probeException =
                    exception as ConnectProbeException;
                Exception classifiedException =
                    probeException != null &&
                    probeException.InnerException != null
                        ? probeException.InnerException
                        : exception;
                Dictionary<string, object> classified =
                    PcSdkErrorClassifier.Describe(
                        classifiedException,
                        request.ExpectedRobotWare);
                object code;
                bool optionMissing =
                    classified.TryGetValue("code", out code) &&
                    String.Equals(
                        code == null ? null : code.ToString(),
                        "ControllerOptionMissing",
                        StringComparison.Ordinal);

                Dictionary<string, object> failure =
                    new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "service", "abb-pcsdk-host" },
                        { "command", "connect-probe" },
                        { "controllerAccessAttempted", true },
                        { "controllerAccessed", probeException != null && probeException.Connected },
                        { "identityVerified", probeException != null && probeException.IdentityVerified },
                        { "failedStage", probeException == null ? "unknown" : probeException.Stage },
                        { "controllerModified", false },
                        { "backupCalled", false },
                        { "getDirectoryCalled", false },
                        { "controllerOptionStatus", optionMissing ? "missing" : "unknown" },
                        { "error", classified }
                    };
                WriteJson(failure);
                return 6;
            }
            finally
            {
                if (request != null)
                {
                    request.Password = null;
                }
            }
        }

        private static int RunBackupFromStandardInput()
        {
            BackupCommandInput input = null;
            BackupRequest request = null;

            try
            {
                if (!Console.IsInputRedirected)
                {
                    WriteJson(CreateError(
                        "BackupStdinRequired",
                        "The backup request must be supplied as JSON through redirected standard input. " +
                        "Credentials are not accepted as command-line arguments."));
                    return 2;
                }

                string json = Console.In.ReadToEnd();
                if (String.IsNullOrWhiteSpace(json))
                {
                    WriteJson(CreateError(
                        "BackupRequestEmpty",
                        "Standard input did not contain a backup request."));
                    return 2;
                }

                try
                {
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = 1024 * 1024;
                    input = serializer.Deserialize<BackupCommandInput>(json);
                }
                catch (Exception exception)
                {
                    Dictionary<string, object> parseError = CreateError(
                        "BackupRequestInvalidJson",
                        "Standard input could not be parsed as a backup request.");
                    parseError["exceptionType"] = exception.GetType().FullName;
                    WriteJson(parseError);
                    return 2;
                }

                if (input == null)
                {
                    WriteJson(CreateError(
                        "BackupRequestInvalid",
                        "Standard input did not contain a JSON object."));
                    return 2;
                }

                Guid systemId;
                if (!Guid.TryParse(input.systemId, out systemId))
                {
                    WriteJson(CreateError(
                        "BackupRequestInvalid",
                        "systemId must be a valid GUID."));
                    return 2;
                }

                request = new BackupRequest
                {
                    SystemId = systemId,
                    ExpectedControllerName = input.expectedControllerName,
                    ExpectedRobotWare = input.expectedRobotWare,
                    UserName = input.userName,
                    Password = input.password,
                    BackupName = input.backupName,
                    LocalDirectory = input.localDirectory,
                    Overwrite = input.overwrite,
                    TimeoutSeconds = input.timeoutSeconds
                };

                PcSdkBackupEngine.ValidateRequestOffline(request);
            }
            catch (Exception exception)
            {
                if (request != null)
                {
                    request.Password = null;
                }

                Dictionary<string, object> error = CreateError(
                    "BackupRequestInvalid",
                    exception.Message);
                error["exceptionType"] = exception.GetType().FullName;
                WriteJson(error);
                return 2;
            }
            finally
            {
                if (input != null)
                {
                    input.password = null;
                }
            }

            try
            {
                BackupResult result = PcSdkBackupEngine.BackupAndDownload(request);
                Dictionary<string, object> payload = new Dictionary<string, object>
                {
                    { "ok", result.Succeeded },
                    { "service", "abb-pcsdk-host" },
                    { "command", "backup" },
                    { "controllerAccessed", true },
                    { "controllerConfigurationModified", false },
                    { "controllerBackupCreated", result.Succeeded },
                    { "result", result }
                };
                WriteJson(payload);
                return result.Succeeded ? 0 : 5;
            }
            catch (Exception exception)
            {
                Dictionary<string, object> failure = new Dictionary<string, object>
                {
                    { "ok", false },
                    { "service", "abb-pcsdk-host" },
                    { "command", "backup" },
                    { "controllerAccessed", true },
                    { "controllerConfigurationModified", false },
                    { "controllerBackupOutcome", "unknown" },
                    { "error", new Dictionary<string, object>
                        {
                            { "code", "BackupExecutionFailed" },
                            { "message", exception.Message },
                            { "exceptionType", exception.GetType().FullName }
                        }
                    }
                };
                WriteJson(failure);
                return 5;
            }
            finally
            {
                if (request != null)
                {
                    request.Password = null;
                }
            }
        }

        private static string GetCommand(string[] args)
        {
            if (args == null || args.Length == 0 || args[0].StartsWith("--", StringComparison.Ordinal))
            {
                return "capability";
            }

            return args[0];
        }

        private static string GetOption(string[] args, string option)
        {
            if (args == null)
            {
                return null;
            }

            for (int index = 0; index < args.Length - 1; index++)
            {
                if (String.Equals(args[index], option, StringComparison.OrdinalIgnoreCase))
                {
                    return args[index + 1];
                }
            }

            return null;
        }

        private static bool IsSuccessful(IDictionary<string, object> payload)
        {
            object value;
            return payload.TryGetValue("ok", out value) && value is bool && (bool)value;
        }

        private static Dictionary<string, object> CreateError(string code, string message)
        {
            Dictionary<string, object> error = new Dictionary<string, object>();
            error["ok"] = false;
            error["controllerAccessed"] = false;
            error["controllerModified"] = false;
            error["error"] = new Dictionary<string, object>
            {
                { "code", code },
                { "message", message }
            };
            return error;
        }

        private static void WriteJson(object payload)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            Console.WriteLine(serializer.Serialize(payload));
        }
    }

    internal sealed class BackupCommandInput
    {
        public string systemId { get; set; }
        public string expectedControllerName { get; set; }
        public string expectedRobotWare { get; set; }
        public string userName { get; set; }
        public string password { get; set; }
        public string backupName { get; set; }
        public string localDirectory { get; set; }
        public bool overwrite { get; set; }
        public int timeoutSeconds { get; set; }
    }
}
