using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsSupervisor
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseShowWindow = 0x00000001;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint ProcThreadAttributeHandleList = 0x00020002;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint Infinite = 0xffffffff;
    private const uint WaitObject0 = 0;
    private const uint ResumeThreadFailed = 0xffffffff;
    private const int SetupFailureExitCode = 125;
    private const int JobCleanupTimeoutMs = 30000;
    private const int ErrorInsufficientBuffer = 122;
    private static string FailureStage = "startup";

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2Length;
        public IntPtr Reserved2;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", EntryPoint = "GetStdHandle", SetLastError = true)]
    private static extern IntPtr GetStandardHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount,
        int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool ConfigureKillOnClose(IntPtr job)
    {
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            return SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string QuoteArgument(string value)
    {
        var quoted = new StringBuilder();
        quoted.Append('"');
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
            }
            else
            {
                quoted.Append('\\', backslashes);
                quoted.Append(character);
                backslashes = 0;
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string BuildCommandLine(string[] arguments)
    {
        var commandLine = new StringBuilder(QuoteArgument(arguments[0]));
        for (var index = 1; index < arguments.Length; index++)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(arguments[index]));
        }
        return commandLine.ToString();
    }

    private static bool DuplicateStandardHandles(out IntPtr[] handles)
    {
        handles = new IntPtr[3];
        var standardHandles = new[] { GetStandardHandle(-10), GetStandardHandle(-11), GetStandardHandle(-12) };
        var current = GetCurrentProcess();
        for (var index = 0; index < standardHandles.Length; index++)
        {
            if (standardHandles[index] == IntPtr.Zero || standardHandles[index] == new IntPtr(-1) ||
                !DuplicateHandle(current, standardHandles[index], current, out handles[index], 0, true, DuplicateSameAccess))
            {
                CloseDuplicatedHandles(handles);
                handles = new IntPtr[0];
                return false;
            }
        }
        return true;
    }

    private static void CloseDuplicatedHandles(IntPtr[] handles)
    {
        foreach (var handle in handles)
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }

    private static bool CreateSuspendedChild(string[] arguments, string workingDirectory, out ProcessInformation processInformation)
    {
        processInformation = new ProcessInformation();
        IntPtr[] standardHandles;
        if (!DuplicateStandardHandles(out standardHandles)) return false;

        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        var attributeListInitialized = false;
        try
        {
            var attributeListSize = IntPtr.Zero;
            var firstInitializationSucceeded = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            var firstInitializationError = Marshal.GetLastWin32Error();
            if (firstInitializationSucceeded || attributeListSize == IntPtr.Zero || firstInitializationError != ErrorInsufficientBuffer) return false;
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize)) return false;
            attributeListInitialized = true;

            handleList = Marshal.AllocHGlobal(IntPtr.Size * standardHandles.Length);
            for (var index = 0; index < standardHandles.Length; index++)
                Marshal.WriteIntPtr(handleList, index * IntPtr.Size, standardHandles[index]);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeHandleList), handleList,
                new IntPtr(IntPtr.Size * standardHandles.Length), IntPtr.Zero, IntPtr.Zero)) return false;

            var startup = new StartupInfoEx();
            startup.StartupInfo.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.Flags = StartfUseShowWindow | StartfUseStdHandles;
            startup.StartupInfo.StandardInput = standardHandles[0];
            startup.StartupInfo.StandardOutput = standardHandles[1];
            startup.StartupInfo.StandardError = standardHandles[2];
            startup.AttributeList = attributeList;

            var commandLine = new StringBuilder(BuildCommandLine(arguments));
            if (commandLine.Length >= 32767) return false;
            var command = arguments[0];
            var applicationName = command.IndexOf('\\') >= 0 || command.IndexOf('/') >= 0 || command.IndexOf(':') >= 0
                ? command : null;
            return CreateProcess(applicationName, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateNoWindow | ExtendedStartupInfoPresent, IntPtr.Zero,
                workingDirectory, ref startup, out processInformation);
        }
        finally
        {
            CloseDuplicatedHandles(standardHandles);
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
        }
    }

    private static bool WaitForJobEmpty(IntPtr job)
    {
        var size = Marshal.SizeOf(typeof(BasicAccountingInformation));
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            var elapsed = Stopwatch.StartNew();
            while (elapsed.ElapsedMilliseconds < JobCleanupTimeoutMs)
            {
                uint returned;
                if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, out returned))
                    return false;
                var information = (BasicAccountingInformation)Marshal.PtrToStructure(buffer, typeof(BasicAccountingInformation));
                if (information.ActiveProcesses == 0) return true;
                Thread.Sleep(10);
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int FailClosed()
    {
        Console.Error.WriteLine("Windows process supervision failed during " + FailureStage + " (Win32 error " + Marshal.GetLastWin32Error() + ").");
        return SetupFailureExitCode;
    }

    public static int Main(string[] arguments)
    {
        if (arguments.Length < 2) return FailClosed();
        var workingDirectory = arguments[1];
        var childArguments = new string[arguments.Length - 1];
        childArguments[0] = arguments[0];
        Array.Copy(arguments, 2, childArguments, 1, arguments.Length - 2);

        IntPtr outerJob = IntPtr.Zero;
        IntPtr innerJob = IntPtr.Zero;
        var supervisorContained = false;
        var processInformation = new ProcessInformation();
        try
        {
            FailureStage = "outer job creation";
            outerJob = CreateJobObject(IntPtr.Zero, null);
            if (outerJob == IntPtr.Zero) return FailClosed();
            FailureStage = "outer job configuration";
            if (!ConfigureKillOnClose(outerJob)) return FailClosed();
            FailureStage = "supervisor job assignment";
            if (!AssignProcessToJobObject(outerJob, GetCurrentProcess())) return FailClosed();
            supervisorContained = true;

            FailureStage = "inner job creation";
            innerJob = CreateJobObject(IntPtr.Zero, null);
            if (innerJob == IntPtr.Zero) return FailClosed();
            FailureStage = "inner job configuration";
            if (!ConfigureKillOnClose(innerJob)) return FailClosed();
            FailureStage = "suspended child creation";
            if (!CreateSuspendedChild(childArguments, workingDirectory, out processInformation)) return FailClosed();

            // The suspended child is already a member of the outer Job Object, so
            // abrupt supervisor death during this assignment cannot orphan it.
            FailureStage = "target job assignment";
            if (!AssignProcessToJobObject(innerJob, processInformation.Process))
            {
                TerminateProcess(processInformation.Process, SetupFailureExitCode);
                WaitForSingleObject(processInformation.Process, Infinite);
                return FailClosed();
            }
            FailureStage = "target resume";
            if (ResumeThread(processInformation.Thread) == ResumeThreadFailed)
            {
                TerminateJobObject(innerJob, SetupFailureExitCode);
                WaitForSingleObject(processInformation.Process, Infinite);
                WaitForJobEmpty(innerJob);
                return FailClosed();
            }

            FailureStage = "target process wait";
            if (WaitForSingleObject(processInformation.Process, Infinite) != WaitObject0)
            {
                TerminateJobObject(innerJob, SetupFailureExitCode);
                WaitForJobEmpty(innerJob);
                return FailClosed();
            }

            uint childExitCode;
            var hasChildExitCode = GetExitCodeProcess(processInformation.Process, out childExitCode);
            if (!hasChildExitCode) childExitCode = SetupFailureExitCode;

            // The supervisor is outside this inner Job Object, so it can terminate
            // and wait for every target descendant before reporting completion.
            FailureStage = "job descendant termination";
            if (!TerminateJobObject(innerJob, childExitCode)) return FailClosed();
            FailureStage = "job descendant settlement";
            if (!WaitForJobEmpty(innerJob)) return FailClosed();

            CloseHandle(innerJob);
            innerJob = IntPtr.Zero;
            return hasChildExitCode ? (int)childExitCode : SetupFailureExitCode;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("Windows process supervision failed during " + FailureStage + " (managed error 0x" + exception.HResult.ToString("X8") + ").");
            return SetupFailureExitCode;
        }
        finally
        {
            if (innerJob != IntPtr.Zero) CloseHandle(innerJob);
            if (processInformation.Thread != IntPtr.Zero) CloseHandle(processInformation.Thread);
            if (processInformation.Process != IntPtr.Zero) CloseHandle(processInformation.Process);
            // Do not close a successfully assigned outer job handle while this
            // process is alive: kill-on-close would terminate the supervisor itself.
            // Process teardown closes it and kills any contained descendants.
            if (!supervisorContained && outerJob != IntPtr.Zero) CloseHandle(outerJob);
        }
    }
}
