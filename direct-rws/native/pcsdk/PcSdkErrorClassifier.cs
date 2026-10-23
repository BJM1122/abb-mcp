using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;

namespace Abb.PcSdkHost
{
    internal static class PcSdkErrorClassifier
    {
        public static Dictionary<string, object> Describe(
            Exception exception,
            string expectedRobotWare)
        {
            Dictionary<string, object> raw = DescribeRaw(exception);
            string combined = CollectMessages(exception);
            string classification = "PcSdkConnectFailed";
            string confidence = "low";
            string requiredOption = ExpectedControllerOption(expectedRobotWare);

            if (Contains(combined, "C0040419") ||
                Contains(combined, "616-1") ||
                Contains(combined, "RW-PC Interface"))
            {
                classification = "ControllerOptionMissing";
                confidence = "high";
                requiredOption = "616-1 PC Interface";
            }
            else if (Contains(combined, "3119-1") ||
                Contains(combined, "RobotStudio Connect"))
            {
                classification = "ControllerOptionMissing";
                confidence = "high";
                requiredOption = "3119-1 RobotStudio Connect";
            }
            else if (Contains(combined, "ROBAPI_E_TRUSTFAILURE") ||
                Contains(combined, "certificate") ||
                Contains(exception.GetType().FullName, "Certificate"))
            {
                classification = "CertificateTrustFailure";
                confidence = "medium";
            }
            else if (Contains(exception.GetType().FullName, "Authentication") ||
                Contains(combined, "authentication") ||
                Contains(combined, "logon"))
            {
                classification = "AuthenticationFailed";
                confidence = "medium";
            }
            else if (Contains(exception.GetType().FullName, "ControllerNotFound"))
            {
                classification = "ControllerNotFound";
                confidence = "high";
            }
            else if (exception is TimeoutException ||
                Contains(combined, "timed out") ||
                Contains(combined, "timeout"))
            {
                classification = "Timeout";
                confidence = "medium";
            }
            else if (Contains(combined, "Network connection") ||
                Contains(combined, "unavailable") ||
                Contains(combined, "not reachable"))
            {
                classification = "ControllerUnavailable";
                confidence = "medium";
            }

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["code"] = classification;
            result["classificationConfidence"] = confidence;
            result["requiredControllerOption"] = requiredOption;
            result["message"] = exception.Message;
            result["raw"] = raw;
            return result;
        }

        public static string ExpectedControllerOption(string expectedRobotWare)
        {
            if (!String.IsNullOrWhiteSpace(expectedRobotWare))
            {
                string[] parts = expectedRobotWare.Split('.');
                int major;
                if (parts.Length > 0 &&
                    Int32.TryParse(parts[0], out major) &&
                    major >= 7)
                {
                    return "3119-1 RobotStudio Connect";
                }
            }

            return "616-1 PC Interface";
        }

        private static Dictionary<string, object> DescribeRaw(Exception exception)
        {
            Dictionary<string, object> raw = new Dictionary<string, object>();
            raw["type"] = exception.GetType().FullName;
            raw["hResult"] = "0x" +
                unchecked((uint)exception.HResult).ToString("X8");
            raw["message"] = exception.Message;

            PropertyInfo robHResult = exception.GetType().GetProperty(
                "RobHResult",
                BindingFlags.Public | BindingFlags.Instance);
            if (robHResult != null)
            {
                object value = SafeGet(robHResult, exception);
                if (value != null)
                {
                    raw["robHResult"] = value.ToString();
                }
            }

            PropertyInfo rawMessage = exception.GetType().GetProperty(
                "RawMessage",
                BindingFlags.Public | BindingFlags.Instance);
            if (rawMessage != null)
            {
                object value = SafeGet(rawMessage, exception);
                if (value != null)
                {
                    raw["rawMessage"] = value.ToString();
                }
            }

            if (exception.InnerException != null)
            {
                raw["inner"] = DescribeRaw(exception.InnerException);
            }

            return raw;
        }

        private static object SafeGet(PropertyInfo property, object target)
        {
            try
            {
                return property.GetValue(target, null);
            }
            catch
            {
                return null;
            }
        }

        private static string CollectMessages(Exception exception)
        {
            StringBuilder builder = new StringBuilder();
            Exception current = exception;
            int depth = 0;
            while (current != null && depth < 8)
            {
                builder.AppendLine(current.GetType().FullName);
                builder.AppendLine(current.Message);

                PropertyInfo rawMessage = current.GetType().GetProperty(
                    "RawMessage",
                    BindingFlags.Public | BindingFlags.Instance);
                if (rawMessage != null)
                {
                    object value = SafeGet(rawMessage, current);
                    if (value != null)
                    {
                        builder.AppendLine(value.ToString());
                    }
                }

                current = current.InnerException;
                depth++;
            }

            return builder.ToString();
        }

        private static bool Contains(string value, string search)
        {
            return !String.IsNullOrEmpty(value) &&
                value.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }
}
