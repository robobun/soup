// icount: run a program under ptrace and count the user-mode instructions that
// execute between pairs of `int3` markers. Region k starts at marker 2k and
// ends at marker 2k+1. Prints one line per region: "<k> <instructions>".
// A `rep`-prefixed string instruction counts once per iteration.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

static int is_marker(pid_t pid)
{
    siginfo_t si;
    if (ptrace(PTRACE_GETSIGINFO, pid, 0, &si) < 0)
        return 0;
    // TRAP_TRACE (2) is a single step. int3 reports SI_KERNEL (0x80) or TRAP_BRKPT (1).
    return si.si_code != TRAP_TRACE;
}

int main(int argc, char** argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: icount <prog> [args...]\n");
        return 2;
    }
    pid_t pid = fork();
    if (!pid) {
        ptrace(PTRACE_TRACEME, 0, 0, 0);
        execvp(argv[1], argv + 1);
        perror("execvp");
        _exit(127);
    }
    int status;
    waitpid(pid, &status, 0); // exec stop
    ptrace(PTRACE_SETOPTIONS, pid, 0, PTRACE_O_EXITKILL);
    int counting = 0;
    unsigned region = 0;
    // ICOUNT_TRACE=<region>:<file> writes the address of every instruction of that region to the file.
    long traceRegion = -1;
    FILE* traceFile = NULL;
    if (getenv("ICOUNT_TRACE")) {
        char* spec = getenv("ICOUNT_TRACE");
        traceRegion = strtol(spec, NULL, 10);
        char* colon = strchr(spec, ':');
        if (colon)
            traceFile = fopen(colon + 1, "w");
    }
    uint64_t count = 0;
    int sig = 0;
    for (;;) {
        if (ptrace(counting ? PTRACE_SINGLESTEP : PTRACE_CONT, pid, 0, sig) < 0) {
            perror("ptrace");
            return 1;
        }
        sig = 0;
        if (waitpid(pid, &status, 0) < 0) {
            perror("waitpid");
            return 1;
        }
        if (WIFEXITED(status))
            return WEXITSTATUS(status);
        if (WIFSIGNALED(status)) {
            fprintf(stderr, "child killed by signal %d\n", WTERMSIG(status));
            return 128 + WTERMSIG(status);
        }
        if (!WIFSTOPPED(status))
            continue;
        int stopsig = WSTOPSIG(status);
        if (stopsig != SIGTRAP) {
            sig = stopsig; // forward
            continue;
        }
        if (is_marker(pid)) {
            if (counting) {
                // The marker instruction itself was stepped: it is not part of the region.
                printf("%u %llu\n", region++, (unsigned long long)count);
                fflush(stdout);
                counting = 0;
                count = 0;
            } else
                counting = 1;
            continue;
        }
        if (counting) {
            count++;
            if (traceFile && (long)region == traceRegion) {
                struct user_regs_struct regs;
                ptrace(PTRACE_GETREGS, pid, 0, &regs);
                fprintf(traceFile, "%llx\n", (unsigned long long)regs.rip);
            }
        }
    }
}
