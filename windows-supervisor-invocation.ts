export interface PiInvocation {
	command: string;
	args: string[];
}

export interface WindowsSupervisorInvocation extends PiInvocation {
	cwd: string;
}

/** Keep the child working directory in spawn options rather than the supervisor command line. */
export function buildWindowsSupervisorInvocation(
	supervisor: string,
	invocation: PiInvocation,
	cwd: string,
	unsetEnvironmentVariables: string[],
): WindowsSupervisorInvocation {
	return {
		command: supervisor,
		args: [invocation.command, unsetEnvironmentVariables.join(";"), ...invocation.args],
		cwd,
	};
}
