using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
[assembly: AssemblyTitle("BloqueAudio")]
[assembly: AssemblyProduct("BloqueAudio")]
[assembly: AssemblyDescription("Podcasts por capitulos")]
// Version is supplied by the build, from package.json.
internal class Launcher {
    static int Main() {
        try {
            Console.Title = "BloqueAudio";
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "start-app.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Conserva BloqueAudio.exe dentro de su carpeta de distribucion.", script);
            var info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Mode Development",
                WorkingDirectory = root, UseShellExecute = false
            };
            using (var process = Process.Start(info)) { process.WaitForExit(); return process.ExitCode; }
        } catch (Exception error) {
            Console.Error.WriteLine("BloqueAudio: " + error.Message);
            if (Environment.GetEnvironmentVariable("BLOQUEAUDIO_NO_BROWSER") != "1") { Console.WriteLine("Pulsa Enter para cerrar."); Console.ReadLine(); }
            return 1;
        }
    }
}
