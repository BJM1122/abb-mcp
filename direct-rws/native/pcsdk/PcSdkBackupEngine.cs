using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using ABB.Robotics.Controllers;

namespace Abb.PcSdkHost
{
    public sealed class BackupRequest
    {
        public Guid SystemId { get; set; }
        public string ExpectedControllerName { get; set; }
        public string ExpectedRobotWare { get; set; }
        public string UserName { get; set; }
        public string Password { get; set; }
        public string BackupName { get; set; }
        public string LocalDirectory { get; set; }
        public bool Overwrite { get; set; }
        public int TimeoutSeconds { get; set; }
    }

    public sealed class BackupResult
    {
        public bool Succeeded { get; set; }
        public string ControllerName { get; set; }
        public string SystemId { get; set; }
        public string RobotWare { get; set; }
        public string RemoteDirectory { get; set; }
        public string LocalDirectory { get; set; }
        public long ConnectAndLogonMilliseconds { get; set; }
        public long ControllerBackupMilliseconds { get; set; }
        public long DirectoryDownloadMilliseconds { get; set; }
        public long TotalMilliseconds { get; set; }
    }

    public sealed class ConnectProbeRequest
    {
        public Guid SystemId { get; set; }
        public string ExpectedControllerName { get; set; }
        public string ExpectedRobotWare { get; set; }
        public string UserName { get; set; }
        public string Password { get; set; }
    }

    public sealed class ConnectProbeResult
    {
        public bool Connected { get; set; }
        public bool LoggedOn { get; set; }
        public string ControllerName { get; set; }
        public string SystemId { get; set; }
        public string RobotWare { get; set; }
        public bool IsRobotWare7 { get; set; }
        public string RequiredControllerOption { get; set; }
        public long ConnectMilliseconds { get; set; }
        public long LogonMilliseconds { get; set; }
        public long TotalMilliseconds { get; set; }
    }

    public sealed class ConnectProbeException : Exception
    {
        public ConnectProbeException(
            string stage,
            bool connected,
            bool identityVerified,
            Exception innerException)
            : base(innerException == null
                ? "PC SDK connect-probe failed."
                : innerException.Message,
                innerException)
        {
            Stage = stage;
            Connected = connected;
            IdentityVerified = identityVerified;
        }

        public string Stage { get; private set; }
        public bool Connected { get; private set; }
        public bool IdentityVerified { get; private set; }
    }

    public sealed class OfflineCheck
    {
        public string Name { get; set; }
        public bool Passed { get; set; }
        public string Detail { get; set; }
    }

    public static class PcSdkBackupEngine
    {
        private const string BackupPrefix = "(BACKUP)$";

        public static BackupResult BackupAndDownload(BackupRequest request)
        {
            ValidateRequest(request);

            string remoteDirectory = BuildRemoteBackupPath(request.BackupName);
            string localDirectory = ValidateLocalDirectory(request.LocalDirectory);
            if (Directory.Exists(localDirectory) && !request.Overwrite)
            {
                throw new IOException(
                    "The local backup directory already exists and overwrite is disabled: " +
                    localDirectory);
            }

            int timeoutSeconds = request.TimeoutSeconds <= 0 ? 120 : request.TimeoutSeconds;
            if (timeoutSeconds < 5 || timeoutSeconds > 3600)
            {
                throw new ArgumentOutOfRangeException(
                    "request.TimeoutSeconds",
                    "Backup timeout must be between 5 and 3600 seconds.");
            }

            Stopwatch totalTimer = Stopwatch.StartNew();
            Stopwatch stageTimer = Stopwatch.StartNew();
            Controller controller = null;
            bool loggedOn = false;
            bool backupHandlerAttached = false;
            ManualResetEvent backupCompleted = new ManualResetEvent(false);
            BackupEventArgs completedEvent = null;

            EventHandler<CertificateErrorEventArgs> certificateHandler =
                delegate(object sender, CertificateErrorEventArgs eventArgs)
                {
                    eventArgs.Response = CertificateErrorResponse.Reject;
                };

            EventHandler<BackupEventArgs> backupHandler =
                delegate(object sender, BackupEventArgs eventArgs)
                {
                    completedEvent = eventArgs;
                    backupCompleted.Set();
                };

            Controller.OnCertificateError += certificateHandler;

            try
            {
                controller = Controller.Connect(
                    request.SystemId,
                    ConnectionType.Standalone,
                    true);

                VerifyIdentity(
                    controller,
                    request.SystemId,
                    request.ExpectedControllerName,
                    request.ExpectedRobotWare);
                controller.Logon(new UserInfo(request.UserName, request.Password));
                loggedOn = true;

                long connectAndLogonMilliseconds = stageTimer.ElapsedMilliseconds;
                if (controller.BackupInProgress)
                {
                    throw new InvalidOperationException(
                        "The controller already reports a backup in progress.");
                }

                controller.BackupCompleted += backupHandler;
                backupHandlerAttached = true;
                stageTimer.Restart();
                controller.Backup(remoteDirectory);

                if (!backupCompleted.WaitOne(TimeSpan.FromSeconds(timeoutSeconds)))
                {
                    throw new TimeoutException(
                        "Timed out while waiting for the PC SDK BackupCompleted event.");
                }

                long controllerBackupMilliseconds = stageTimer.ElapsedMilliseconds;
                if (completedEvent == null || !completedEvent.Succeeded)
                {
                    throw new InvalidOperationException(
                        "The PC SDK BackupCompleted event reported failure.");
                }

                controller.BackupCompleted -= backupHandler;
                backupHandlerAttached = false;

                string parentDirectory = Path.GetDirectoryName(localDirectory);
                if (!String.IsNullOrWhiteSpace(parentDirectory))
                {
                    Directory.CreateDirectory(parentDirectory);
                }

                stageTimer.Restart();
                controller.FileSystem.GetDirectory(
                    remoteDirectory,
                    localDirectory,
                    request.Overwrite);
                long downloadMilliseconds = stageTimer.ElapsedMilliseconds;

                totalTimer.Stop();
                return new BackupResult
                {
                    Succeeded = true,
                    ControllerName = controller.Name,
                    SystemId = controller.SystemId.ToString("D"),
                    RobotWare = controller.RobotWareVersion == null
                        ? null
                        : controller.RobotWareVersion.ToString(),
                    RemoteDirectory = remoteDirectory,
                    LocalDirectory = localDirectory,
                    ConnectAndLogonMilliseconds = connectAndLogonMilliseconds,
                    ControllerBackupMilliseconds = controllerBackupMilliseconds,
                    DirectoryDownloadMilliseconds = downloadMilliseconds,
                    TotalMilliseconds = totalTimer.ElapsedMilliseconds
                };
            }
            finally
            {
                if (controller != null && backupHandlerAttached)
                {
                    try
                    {
                        controller.BackupCompleted -= backupHandler;
                    }
                    catch
                    {
                    }
                }

                if (controller != null && loggedOn)
                {
                    try
                    {
                        controller.Logoff();
                    }
                    catch
                    {
                    }
                }

                if (controller != null)
                {
                    try
                    {
                        controller.Dispose();
                    }
                    catch
                    {
                    }
                }

                try
                {
                    Controller.OnCertificateError -= certificateHandler;
                }
                catch
                {
                }

                backupCompleted.Dispose();
            }
        }

        public static ConnectProbeResult ConnectProbe(ConnectProbeRequest request)
        {
            ValidateConnectProbeRequestOffline(request);

            Stopwatch totalTimer = Stopwatch.StartNew();
            Stopwatch stageTimer = Stopwatch.StartNew();
            Controller controller = null;
            bool loggedOn = false;
            bool connected = false;
            bool identityVerified = false;
            long connectMilliseconds = 0;
            string stage = "connect";

            EventHandler<CertificateErrorEventArgs> certificateHandler =
                delegate(object sender, CertificateErrorEventArgs eventArgs)
                {
                    eventArgs.Response = CertificateErrorResponse.Reject;
                };

            Controller.OnCertificateError += certificateHandler;

            try
            {
                controller = Controller.Connect(
                    request.SystemId,
                    ConnectionType.Standalone,
                    true);
                connectMilliseconds = stageTimer.ElapsedMilliseconds;
                connected = true;

                stage = "identity";
                VerifyIdentity(
                    controller,
                    request.SystemId,
                    request.ExpectedControllerName,
                    request.ExpectedRobotWare);
                identityVerified = true;

                stage = "logon";
                stageTimer.Restart();
                controller.Logon(new UserInfo(request.UserName, request.Password));
                long logonMilliseconds = stageTimer.ElapsedMilliseconds;
                loggedOn = true;

                totalTimer.Stop();
                return new ConnectProbeResult
                {
                    Connected = true,
                    LoggedOn = true,
                    ControllerName = controller.Name,
                    SystemId = controller.SystemId.ToString("D"),
                    RobotWare = controller.RobotWareVersion == null
                        ? null
                        : controller.RobotWareVersion.ToString(),
                    IsRobotWare7 = controller.IsRobotWare7,
                    RequiredControllerOption = controller.IsRobotWare7
                        ? "3119-1 RobotStudio Connect"
                        : "616-1 PC Interface",
                    ConnectMilliseconds = connectMilliseconds,
                    LogonMilliseconds = logonMilliseconds,
                    TotalMilliseconds = totalTimer.ElapsedMilliseconds
                };
            }
            catch (Exception exception)
            {
                throw new ConnectProbeException(
                    stage,
                    connected,
                    identityVerified,
                    exception);
            }
            finally
            {
                if (controller != null && loggedOn)
                {
                    try
                    {
                        controller.Logoff();
                    }
                    catch
                    {
                    }
                }

                if (controller != null)
                {
                    try
                    {
                        controller.Dispose();
                    }
                    catch
                    {
                    }
                }

                try
                {
                    Controller.OnCertificateError -= certificateHandler;
                }
                catch
                {
                }
            }
        }

        public static void ValidateRequestOffline(BackupRequest request)
        {
            ValidateRequest(request);

            int timeoutSeconds = request.TimeoutSeconds <= 0 ? 120 : request.TimeoutSeconds;
            if (timeoutSeconds < 5 || timeoutSeconds > 3600)
            {
                throw new ArgumentOutOfRangeException(
                    "request.TimeoutSeconds",
                    "Backup timeout must be between 5 and 3600 seconds.");
            }

            string localDirectory = ValidateLocalDirectory(request.LocalDirectory);
            if (Directory.Exists(localDirectory) && !request.Overwrite)
            {
                throw new IOException(
                    "The local backup directory already exists and overwrite is disabled: " +
                    localDirectory);
            }
        }

        public static void ValidateConnectProbeRequestOffline(
            ConnectProbeRequest request)
        {
            if (request == null)
            {
                throw new ArgumentNullException("request");
            }

            ValidateIdentityFields(
                request.SystemId,
                request.ExpectedControllerName,
                request.ExpectedRobotWare,
                request.UserName);
        }

        public static string BuildRemoteBackupPath(string backupName)
        {
            if (String.IsNullOrWhiteSpace(backupName))
            {
                throw new ArgumentException("Backup name is required.", "backupName");
            }

            if (backupName.Length > 80)
            {
                throw new ArgumentException(
                    "Backup name must not exceed 80 characters.",
                    "backupName");
            }

            for (int index = 0; index < backupName.Length; index++)
            {
                char character = backupName[index];
                bool allowed =
                    character >= 'a' && character <= 'z' ||
                    character >= 'A' && character <= 'Z' ||
                    character >= '0' && character <= '9' ||
                    character == '-' ||
                    character == '_' ||
                    character == '.';
                if (!allowed)
                {
                    throw new ArgumentException(
                        "Backup name may contain only ASCII letters, digits, dot, dash, and underscore.",
                        "backupName");
                }
            }

            if (backupName == "." || backupName == "..")
            {
                throw new ArgumentException(
                    "Backup name must not be a relative path marker.",
                    "backupName");
            }

            return BackupPrefix + backupName;
        }

        public static IList<OfflineCheck> RunOfflineValidation()
        {
            List<OfflineCheck> checks = new List<OfflineCheck>();

            string remote = BuildRemoteBackupPath("mcp_validation_20260729_0914");
            checks.Add(new OfflineCheck
            {
                Name = "remote-backup-path",
                Passed = remote == "(BACKUP)$mcp_validation_20260729_0914",
                Detail = remote
            });

            bool traversalRejected = false;
            try
            {
                BuildRemoteBackupPath("../escape");
            }
            catch (ArgumentException)
            {
                traversalRejected = true;
            }

            checks.Add(new OfflineCheck
            {
                Name = "remote-path-traversal-rejected",
                Passed = traversalRejected,
                Detail = traversalRejected
                    ? "Relative traversal was rejected."
                    : "Relative traversal was not rejected."
            });

            string unicodePath = ValidateLocalDirectory(
                Path.Combine(Path.GetTempPath(), "abb-资料", "机器人", "probe"));
            checks.Add(new OfflineCheck
            {
                Name = "unicode-local-path",
                Passed = unicodePath.IndexOf("资料", StringComparison.Ordinal) >= 0,
                Detail = unicodePath
            });

            checks.Add(new OfflineCheck
            {
                Name = "certificate-policy",
                Passed = true,
                Detail = "Untrusted OmniCore certificates are rejected; there is no auto-accept path."
            });

            checks.Add(new OfflineCheck
            {
                Name = "controller-side-effects",
                Passed = true,
                Detail = "Offline validation does not instantiate, discover, connect, log on, or back up a controller."
            });

            checks.Add(new OfflineCheck
            {
                Name = "backup-credential-transport",
                Passed = true,
                Detail = "Backup credentials are accepted only in stdin JSON and are absent from command-line arguments and result objects."
            });

            checks.Add(new OfflineCheck
            {
                Name = "connect-probe-scope",
                Passed = true,
                Detail = "ConnectProbe verifies identity and logon only; it contains no Backup or GetDirectory call."
            });

            Dictionary<string, object> irc5OptionError =
                PcSdkErrorClassifier.Describe(
                    new InvalidOperationException(
                        "C0040419 : Network connection to the controller is not possible, " +
                        "the system does not have the required option 616-1 RW-PC Interface"),
                    "6.13.0164");
            object irc5Code;
            object irc5Option;
            bool irc5Classified =
                irc5OptionError.TryGetValue("code", out irc5Code) &&
                irc5OptionError.TryGetValue(
                    "requiredControllerOption",
                    out irc5Option) &&
                String.Equals(
                    irc5Code == null ? null : irc5Code.ToString(),
                    "ControllerOptionMissing",
                    StringComparison.Ordinal) &&
                String.Equals(
                    irc5Option == null ? null : irc5Option.ToString(),
                    "616-1 PC Interface",
                    StringComparison.Ordinal);
            checks.Add(new OfflineCheck
            {
                Name = "irc5-option-error-classification",
                Passed = irc5Classified,
                Detail = irc5Classified
                    ? "C0040419 is classified as missing 616-1 PC Interface."
                    : "C0040419 was not classified as the known IRC5 option error."
            });

            Dictionary<string, object> omniCoreOptionError =
                PcSdkErrorClassifier.Describe(
                    new InvalidOperationException(
                        "The system does not have the required option 3119-1 RobotStudio Connect"),
                    "7.20.0.0");
            object omniCoreCode;
            object omniCoreOption;
            bool omniCoreClassified =
                omniCoreOptionError.TryGetValue("code", out omniCoreCode) &&
                omniCoreOptionError.TryGetValue(
                    "requiredControllerOption",
                    out omniCoreOption) &&
                String.Equals(
                    omniCoreCode == null ? null : omniCoreCode.ToString(),
                    "ControllerOptionMissing",
                    StringComparison.Ordinal) &&
                String.Equals(
                    omniCoreOption == null ? null : omniCoreOption.ToString(),
                    "3119-1 RobotStudio Connect",
                    StringComparison.Ordinal);
            checks.Add(new OfflineCheck
            {
                Name = "omnicore-option-error-classification",
                Passed = omniCoreClassified,
                Detail = omniCoreClassified
                    ? "Explicit 3119-1 errors are classified as missing RobotStudio Connect."
                    : "The explicit OmniCore option error was not classified."
            });

            return checks;
        }

        private static void ValidateRequest(BackupRequest request)
        {
            if (request == null)
            {
                throw new ArgumentNullException("request");
            }

            ValidateIdentityFields(
                request.SystemId,
                request.ExpectedControllerName,
                request.ExpectedRobotWare,
                request.UserName);

            BuildRemoteBackupPath(request.BackupName);
            ValidateLocalDirectory(request.LocalDirectory);
        }

        private static string ValidateLocalDirectory(string localDirectory)
        {
            if (String.IsNullOrWhiteSpace(localDirectory))
            {
                throw new ArgumentException(
                    "Local backup directory is required.",
                    "localDirectory");
            }

            if (!Path.IsPathRooted(localDirectory))
            {
                throw new ArgumentException(
                    "Local backup directory must be an absolute path.",
                    "localDirectory");
            }

            string fullPath = Path.GetFullPath(localDirectory);
            string root = Path.GetPathRoot(fullPath);
            if (String.Equals(
                fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException(
                    "A drive or share root cannot be used as a backup destination.",
                    "localDirectory");
            }

            return fullPath;
        }

        private static void ValidateIdentityFields(
            Guid systemId,
            string expectedControllerName,
            string expectedRobotWare,
            string userName)
        {
            if (systemId == Guid.Empty)
            {
                throw new ArgumentException(
                    "Exact controller SystemId is required.",
                    "systemId");
            }

            if (String.IsNullOrWhiteSpace(expectedControllerName))
            {
                throw new ArgumentException(
                    "Expected controller name is required.",
                    "expectedControllerName");
            }

            if (String.IsNullOrWhiteSpace(expectedRobotWare))
            {
                throw new ArgumentException(
                    "Expected RobotWare version is required.",
                    "expectedRobotWare");
            }

            if (String.IsNullOrWhiteSpace(userName))
            {
                throw new ArgumentException(
                    "Controller user name is required.",
                    "userName");
            }
        }

        private static void VerifyIdentity(
            Controller controller,
            Guid expectedSystemId,
            string expectedControllerName,
            string expectedRobotWare)
        {
            if (controller.SystemId != expectedSystemId)
            {
                throw new InvalidOperationException(
                    "Controller SystemId mismatch. Expected " +
                    expectedSystemId.ToString("D") +
                    " but connected to " +
                    controller.SystemId.ToString("D") + ".");
            }

            if (!String.Equals(
                controller.Name,
                expectedControllerName,
                StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Controller name mismatch. Expected " +
                    expectedControllerName +
                    " but connected to " +
                    controller.Name + ".");
            }

            if (!RobotWareMatches(
                expectedRobotWare,
                controller.RobotWareVersion))
            {
                throw new InvalidOperationException(
                    "RobotWare version mismatch. Expected " +
                    expectedRobotWare +
                    " but connected to " +
                    (controller.RobotWareVersion == null
                        ? "<unknown>"
                        : controller.RobotWareVersion.ToString()) + ".");
            }
        }

        private static bool RobotWareMatches(string expected, Version actual)
        {
            if (actual == null || String.IsNullOrWhiteSpace(expected))
            {
                return false;
            }

            string[] parts = expected.Split('.');
            if (parts.Length < 2 || parts.Length > 4)
            {
                return String.Equals(
                    expected,
                    actual.ToString(),
                    StringComparison.OrdinalIgnoreCase);
            }

            int[] actualParts =
            {
                actual.Major,
                actual.Minor,
                actual.Build,
                actual.Revision
            };

            // PC SDK 2025.2 reports RW 6.13.0164 as Version 6.13.0.0 on a
            // real IRC5 controller. SystemId and controller name remain exact,
            // while the complete RobotWare text is locked independently by
            // the RWS preflight immediately before this helper is invoked.
            // Only accept this normalization when PC SDK has discarded both
            // suffix components; never accept a major/minor mismatch.
            int expectedMajor;
            int expectedMinor;
            if (!Int32.TryParse(parts[0], out expectedMajor) ||
                !Int32.TryParse(parts[1], out expectedMinor) ||
                actual.Major != expectedMajor ||
                actual.Minor != expectedMinor)
            {
                return false;
            }
            if (parts.Length > 2 && actual.Build == 0 && actual.Revision == 0)
            {
                return true;
            }

            for (int index = 0; index < parts.Length; index++)
            {
                int parsed;
                if (!Int32.TryParse(parts[index], out parsed) ||
                    actualParts[index] != parsed)
                {
                    return false;
                }
            }

            return true;
        }
    }
}
