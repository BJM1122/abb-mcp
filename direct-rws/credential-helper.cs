using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Xml;

internal static class CredentialHelper
{
    private static byte[] ParseHex(string value)
    {
        if (value == null || value.Length == 0 || value.Length % 2 != 0)
        {
            throw new InvalidDataException("The DPAPI SecureString payload is not valid hexadecimal data.");
        }

        byte[] bytes = new byte[value.Length / 2];
        for (int index = 0; index < bytes.Length; index++)
        {
            bytes[index] = Convert.ToByte(value.Substring(index * 2, 2), 16);
        }
        return bytes;
    }

    private static string Base64Utf8(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? String.Empty));
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 3 && args[0] == "--replace")
            {
                string source = Path.GetFullPath(args[1]);
                string destination = Path.GetFullPath(args[2]);
                if (!File.Exists(source))
                {
                    throw new FileNotFoundException("Atomic replace source was not found.", source);
                }
                if (File.Exists(destination))
                {
                    File.Replace(source, destination, null, true);
                }
                else
                {
                    File.Move(source, destination);
                }
                return 0;
            }

            if (args.Length != 1 || String.IsNullOrWhiteSpace(args[0]))
            {
                Console.Error.WriteLine(
                    "Usage: abb-credential-helper.exe <credential.clixml> | --replace <source> <destination>"
                );
                return 2;
            }

            string path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(args[0]));
            if (!File.Exists(path))
            {
                throw new FileNotFoundException("ABB DPAPI credential file was not found.", path);
            }

            XmlDocument document = new XmlDocument();
            document.PreserveWhitespace = false;
            document.Load(path);
            XmlNode usernameNode = document.SelectSingleNode(
                "//*[local-name()='S' and @N='UserName']"
            );
            XmlNode passwordNode = document.SelectSingleNode(
                "//*[local-name()='SS' and @N='Password']"
            );
            if (usernameNode == null || passwordNode == null)
            {
                throw new InvalidDataException(
                    "The ABB credential file does not contain a PSCredential UserName and Password."
                );
            }

            byte[] protectedBytes = ParseHex(passwordNode.InnerText.Trim());
            byte[] clearBytes = ProtectedData.Unprotect(
                protectedBytes,
                null,
                DataProtectionScope.CurrentUser
            );
            string password = Encoding.Unicode.GetString(clearBytes).TrimEnd('\0');

            Console.OutputEncoding = new UTF8Encoding(false);
            // Base64 keeps the pipe protocol unambiguous and prevents user names or
            // passwords containing newlines, quotes, or non-ASCII text from corrupting it.
            Console.WriteLine(Base64Utf8(usernameNode.InnerText));
            Console.WriteLine(Base64Utf8(password));

            Array.Clear(clearBytes, 0, clearBytes.Length);
            password = null;
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().FullName + ": " + error.Message);
            return 1;
        }
    }
}
