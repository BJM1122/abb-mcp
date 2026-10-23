using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace Abb.PcSdkHost
{
    internal static class SdkAssemblyResolver
    {
        private static readonly object SyncRoot = new object();
        private static readonly HashSet<string> AllowedAssemblyNames =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "ABB.Robotics.Controllers.PC",
                "RobotStudio.Services.RobApi",
                "RobotStudio.Services.RobApi.Desktop"
            };

        private static bool installed;
        private static string sdkDirectory;

        public static void Install(string directory)
        {
            if (String.IsNullOrWhiteSpace(directory))
            {
                throw new ArgumentException("PC SDK directory is required.", "directory");
            }

            lock (SyncRoot)
            {
                string normalized = Path.GetFullPath(directory);
                if (installed)
                {
                    if (!String.Equals(sdkDirectory, normalized, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException(
                            "The PC SDK resolver is already locked to a different directory.");
                    }

                    return;
                }

                sdkDirectory = normalized;
                AppDomain.CurrentDomain.AssemblyResolve += ResolveAssembly;
                installed = true;
            }
        }

        private static Assembly ResolveAssembly(object sender, ResolveEventArgs eventArgs)
        {
            AssemblyName requested = new AssemblyName(eventArgs.Name);
            if (!AllowedAssemblyNames.Contains(requested.Name))
            {
                return null;
            }

            string candidate = Path.Combine(sdkDirectory, requested.Name + ".dll");
            if (!File.Exists(candidate))
            {
                return null;
            }

            AssemblyName available = AssemblyName.GetAssemblyName(candidate);
            if (requested.Version != null && available.Version != requested.Version)
            {
                throw new FileLoadException(
                    "PC SDK dependency version mismatch. Requested " + requested.FullName +
                    " but found " + available.FullName + ".",
                    candidate);
            }

            return Assembly.LoadFrom(candidate);
        }
    }
}
