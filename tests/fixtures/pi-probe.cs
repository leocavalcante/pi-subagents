using System;
using System.IO;
using System.Reflection;

internal static class PiProbe
{
    private static int Main(string[] arguments)
    {
        Console.In.ReadToEnd();
        var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        File.WriteAllText(Path.Combine(directory, "pi-probe-launched"), "launched");
        Console.WriteLine("{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"probe\"}],\"stopReason\":\"stop\"}}");
        return 0;
    }
}
