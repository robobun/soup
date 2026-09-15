declare module "bun" {
  type ShellExpression =
    | { toString(): string }
    | Array<ShellExpression>
    | string
    | { raw: string }
    | Subprocess<SpawnOptions.Writable, SpawnOptions.Readable, SpawnOptions.Readable>
    | SpawnOptions.Readable
    | SpawnOptions.Writable
    | ReadableStream;

  /**
   * Runs a shell command with the [Bun Shell](https://bun.com/docs/runtime/shell).
   *
   * @example
   * ```ts
   * const result = await $`echo "Hello, world!"`.text();
   * console.log(result); // "Hello, world!"
   * ```
   *
   * @category Process Management
   */
  function $(strings: TemplateStringsArray, ...expressions: ShellExpression[]): $.ShellPromise;

  type $ = typeof $;

  namespace $ {
    /**
     * Perform bash-like brace expansion on the given pattern.
     * @param pattern Brace pattern to expand
     *
     * @example
     * ```js
     * const result = braces('index.{js,jsx,ts,tsx}');
     * console.log(result) // ['index.js', 'index.jsx', 'index.ts', 'index.tsx']
     * ```
     */
    function braces(pattern: string): string[];

    /**
     * Escape strings for input into shell commands.
     * @param input
     */
    function escape(input: string): string;

    /**
     * Change the default environment variables for shells created by this instance.
     *
     * @param newEnv Default environment variables to use for shells created by this instance
     * @default process.env
     *
     * @example
     * ```js
     * import {$} from 'bun';
     * $.env({ BUN: "bun" });
     * await $`echo $BUN`;
     * // "bun"
     * ```
     */
    function env(newEnv?: Record<string, string | undefined> | NodeJS.Dict<string> | undefined): $;

    /**
     * Change the default working directory for shells created by this instance.
     *
     * @param newCwd Default working directory to use for shells created by this instance
     */
    function cwd(newCwd?: string): $;

    /**
     * Configure the shell to not throw an exception on non-zero exit codes.
     */
    function nothrow(): $;

    /**
     * Configure whether the shell should throw an exception on non-zero exit codes.
     */
    function throws(shouldThrow: boolean): $;

    /**
     * A shell command that runs once awaited, or once an output method like
     * `.text()` or `.json()` is called.
     *
     * @example
     * ```ts
     * const myShellPromise = $`echo "Hello, world!"`;
     * const result = await myShellPromise.text();
     * console.log(result); // "Hello, world!"
     * ```
     */
    class ShellPromise extends Promise<ShellOutput> {
      get stdin(): WritableStream;

      /**
       * Change the current working directory of the shell.
       * @param newCwd The new working directory
       */
      cwd(newCwd: string): this;

      /**
       * Set environment variables for the shell.
       * @param newEnv The new environment variables
       *
       * @example
       * ```ts
       * const { stdout } = await $`echo $FOO`.env({ ...process.env, FOO: "bun" });
       * console.log(stdout.toString()); // "bun\n"
       * ```
       */
      env(newEnv: Record<string, string | undefined> | NodeJS.Dict<string> | undefined): this;

      /**
       * By default, the shell writes to the current process's stdout and stderr while also buffering that output.
       *
       * `quiet()` configures the shell to only buffer the output.
       * @param isQuiet Whether to suppress output. Defaults to `true`
       */
      quiet(isQuiet?: boolean): this;

      /**
       * Read from stdout as a string, line by line
       *
       * Automatically calls {@link quiet} to disable echoing to stdout.
       */
      lines(): AsyncIterable<string>;

      /**
       * Read from stdout as a string.
       *
       * Automatically calls {@link quiet} to disable echoing to stdout.
       *
       * @param encoding The encoding to use when decoding the output
       * @returns A promise that resolves with stdout as a string
       *
       * @example
       * **Read as UTF-8 string**
       * ```ts
       * const output = await $`echo hello`.text();
       * console.log(output); // "hello\n"
       * ```
       *
       * **Read as base64 string**
       * ```ts
       * const output = await $`echo ${atob("hello")}`.text("base64");
       * console.log(output); // "hello\n"
       * ```
       */
      text(encoding?: BufferEncoding): Promise<string>;

      /**
       * Read from stdout as a JSON object
       *
       * Automatically calls {@link quiet}
       *
       * @returns A promise that resolves with stdout as a JSON object
       * @example
       *
       * ```ts
       * const output = await $`echo '{"hello": 123}'`.json();
       * console.log(output); // { hello: 123 }
       * ```
       *
       */
      json(): Promise<any>;

      /**
       * Read from stdout as an ArrayBuffer
       *
       * Automatically calls {@link quiet}
       * @returns A promise that resolves with stdout as an ArrayBuffer
       * @example
       *
       * ```ts
       * const output = await $`echo hello`.arrayBuffer();
       * console.log(output); // ArrayBuffer { byteLength: 6 }
       * ```
       */
      arrayBuffer(): Promise<ArrayBuffer>;

      /**
       * Read from stdout as a Blob
       *
       * Automatically calls {@link quiet}
       * @returns A promise that resolves with stdout as a Blob
       * @example
       * ```ts
       * const output = await $`echo hello`.blob();
       * console.log(output); // Blob { size: 6, type: "" }
       * ```
       */
      blob(): Promise<Blob>;

      /**
       * Configure the shell to not throw an exception on non-zero exit codes. Throwing can be re-enabled with `.throws(true)`.
       *
       * By default, the shell throws an exception on commands that return non-zero exit codes.
       */
      nothrow(): this;

      /**
       * Configure whether the shell should throw an exception on non-zero exit codes.
       *
       * By default, this is configured to `true`.
       */
      throws(shouldThrow: boolean): this;

      /**
       * Start the script now, without waiting for it to finish. Otherwise it
       * starts once it is awaited, or once an output method like `.text()` is called.
       *
       * @example
       * ```ts
       * const server = $`bun run dev`.nothrow().run();
       * // ...
       * server.kill();
       * await server;
       * ```
       */
      run(): this;

      /**
       * Stop the script, whatever the signal is. `signal` is sent to every
       * process the script is running, nothing else is started (the rest of a
       * `;`, `&&` or `||` list, the other branch of an `if`, ...), and
       * builtins that are waiting for input see it end.
       *
       * The promise settles once those processes have exited, as for any
       * other exit code: the script's exit code is 128 plus the signal number
       * (143 for `SIGTERM`), so it rejects with a {@link ShellError} unless
       * {@link nothrow} was called. `stdout` and `stderr` hold what was
       * written until then.
       *
       * On a script that has not started, nothing will run. On a script that
       * has finished, nothing happens. Only the first signal decides the exit
       * code; a later call, with `"SIGKILL"` say, reaches what ignored it.
       *
       * Signals go to the processes the shell started, not to their own
       * children.
       *
       * @param signal A signal name or number. Defaults to what {@link killSignal} set, or `"SIGTERM"`.
       *
       * @example
       * ```ts
       * const ping = $`ping bun.com`.nothrow();
       * process.on("SIGINT", () => ping.kill());
       * const { exitCode } = await ping; // 143 after Ctrl+C
       * ```
       */
      kill(signal?: number | NodeJS.Signals): void;

      /**
       * Set the signal that {@link kill} sends by default, and that
       * {@link signal} and {@link timeout} send. Defaults to `"SIGTERM"`.
       *
       * @example
       * ```ts
       * await $`bun run build`.timeout(60_000).killSignal("SIGKILL");
       * ```
       */
      killSignal(signal: number | NodeJS.Signals): this;

      /**
       * Kill the script when `signal` is aborted, as {@link kill} does. If it
       * is already aborted, nothing runs.
       *
       * The promise does not reject with the signal's `reason`. It settles as
       * it does after `kill()`, with the output so far and exit code 143.
       *
       * @example
       * ```ts
       * const controller = new AbortController();
       * const result = $`bun test`.nothrow().signal(controller.signal);
       * controller.abort();
       * (await result).exitCode; // 143
       * ```
       */
      signal(signal: AbortSignal): this;

      /**
       * Kill the script, as {@link kill} does, if it is still running `ms`
       * milliseconds after it started.
       *
       * @example
       * ```ts
       * try {
       *   await $`curl ${url}`.timeout(5000);
       * } catch (error) {
       *   error.exitCode; // 143 when it timed out
       *   error.stderr; // what curl printed until then
       * }
       * ```
       */
      timeout(ms: number): this;
    }

    /**
     * An error that occurred while executing a shell command with [the Bun Shell](https://bun.com/docs/runtime/shell).
     *
     * @example
     * ```ts
     * try {
     *   const result = await $`exit 1`;
     * } catch (error) {
     *   if (error instanceof $.ShellError) {
     *     console.log(error.exitCode); // 1
     *   }
     * }
     * ```
     */
    class ShellError extends Error implements ShellOutput {
      readonly stdout: Buffer;
      readonly stderr: Buffer;
      readonly exitCode: number;

      /**
       * Read from stdout as a string
       *
       * @param encoding The encoding to use when decoding the output
       * @returns Stdout as a string with the given encoding
       *
       * @example
       * **Read as UTF-8 string**
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.text()); // "hello\n"
       * ```
       *
       * **Read as base64 string**
       * ```ts
       * const output = await $`echo ${atob("hello")}`;
       * console.log(output.text("base64")); // "hello\n"
       * ```
       */
      text(encoding?: BufferEncoding): string;

      /**
       * Read from stdout as a JSON object
       *
       * @returns Stdout as a JSON object
       * @example
       *
       * ```ts
       * const output = await $`echo '{"hello": 123}'`;
       * console.log(output.json()); // { hello: 123 }
       * ```
       *
       */
      json(): any;

      /**
       * Read from stdout as an ArrayBuffer
       *
       * @returns Stdout as an ArrayBuffer
       * @example
       *
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.arrayBuffer()); // ArrayBuffer { byteLength: 6 }
       * ```
       */
      arrayBuffer(): ArrayBuffer;

      /**
       * Read from stdout as a Blob
       *
       * @returns Stdout as a blob
       * @example
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.blob()); // Blob { size: 6, type: "" }
       * ```
       */
      blob(): Blob;

      /**
       * Read from stdout as a Uint8Array
       *
       * @returns Stdout as a Uint8Array
       * @example
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.bytes()); // Uint8Array { byteLength: 6 }
       * ```
       */
      bytes(): Uint8Array<ArrayBuffer>;
    }

    interface ShellOutput {
      readonly stdout: Buffer;
      readonly stderr: Buffer;
      readonly exitCode: number;

      /**
       * Read from stdout as a string
       *
       * @param encoding The encoding to use when decoding the output
       * @returns Stdout as a string with the given encoding
       *
       * @example
       * **Read as UTF-8 string**
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.text()); // "hello\n"
       * ```
       *
       * **Read as base64 string**
       * ```ts
       * const output = await $`echo ${atob("hello")}`;
       * console.log(output.text("base64")); // "hello\n"
       * ```
       */
      text(encoding?: BufferEncoding): string;

      /**
       * Read from stdout as a JSON object
       *
       * @returns Stdout as a JSON object
       * @example
       *
       * ```ts
       * const output = await $`echo '{"hello": 123}'`;
       * console.log(output.json()); // { hello: 123 }
       * ```
       *
       */
      json(): any;

      /**
       * Read from stdout as an ArrayBuffer
       *
       * @returns Stdout as an ArrayBuffer
       * @example
       *
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.arrayBuffer()); // ArrayBuffer { byteLength: 6 }
       * ```
       */
      arrayBuffer(): ArrayBuffer;

      /**
       * Read from stdout as a Uint8Array
       *
       * @returns Stdout as a Uint8Array
       * @example
       *
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.bytes()); // Uint8Array { byteLength: 6 }
       * ```
       */
      bytes(): Uint8Array<ArrayBuffer>;

      /**
       * Read from stdout as a Blob
       *
       * @returns Stdout as a blob
       * @example
       * ```ts
       * const output = await $`echo hello`;
       * console.log(output.blob()); // Blob { size: 6, type: "" }
       * ```
       */
      blob(): Blob;
    }

    const Shell: new () => $;
  }
}
