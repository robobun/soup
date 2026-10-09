import { expectAssignable, expectType } from "./utilities";

Bun.build({
  entrypoints: ["hey"],
  splitting: false,
});

// Build.CompileTarget should accept SIMD variants (issue #26247)
expectAssignable<Bun.Build.CompileTarget>("bun-linux-x64-modern");
expectAssignable<Bun.Build.CompileTarget>("bun-linux-x64-baseline");
expectAssignable<Bun.Build.CompileTarget>("bun-linux-arm64-modern");
expectAssignable<Bun.Build.CompileTarget>("bun-linux-arm64-baseline");
expectAssignable<Bun.Build.CompileTarget>("bun-linux-x64-modern-glibc");
expectAssignable<Bun.Build.CompileTarget>("bun-linux-x64-modern-musl");
expectAssignable<Bun.Build.CompileTarget>("bun-darwin-x64-modern");
expectAssignable<Bun.Build.CompileTarget>("bun-darwin-arm64-baseline");
expectAssignable<Bun.Build.CompileTarget>("bun-windows-x64-modern");

Bun.build({
  entrypoints: ["hey"],
  splitting: false,
  compile: {},
});

Bun.build({
  entrypoints: ["hey"],
  format: "iife",
  globalName: "acme.plugins.hey",
});

Bun.build({
  entrypoints: ["hey"],
  format: "iife",
  // @ts-expect-error
  globalName: ["hey"],
});

Bun.build({
  entrypoints: ["hey"],
  legalComments: "linked",
});

Bun.build({
  entrypoints: ["hey"],
  // @ts-expect-error
  legalComments: true,
});

Bun.build({
  entrypoints: ["hey"],
  plugins: [
    {
      name: "my-terrible-plugin",
      setup(build) {
        expectType(build).is<Bun.PluginBuilder>();

        build.onResolve({ filter: /^hey$/ }, args => {
          expectType(args).is<Bun.OnResolveArgs>();

          return { path: args.path };
        });

        build.onLoad({ filter: /^hey$/ }, args => {
          expectType(args).is<Bun.OnLoadArgs>();

          return { contents: "hey", loader: "js" };
        });

        build.onStart(() => {});

        build.onEnd(result => {
          expectType(result).is<Bun.BuildOutput>();
          expectType(result.success).is<boolean>();
          expectType(result.outputs).is<Bun.BuildArtifact[]>();
          expectType(result.logs).is<Array<BuildMessage | ResolveMessage>>();
        });

        build.onBeforeParse(
          {
            namespace: "file",
            filter: /\.tsx$/,
          },
          {
            napiModule: {},
            symbol: "replace_foo_with_bar",
            // external: myNativeAddon.getSharedState()
          },
        );
      },
    },
  ],
});

// Without `watch`, or with `watch: false`, Bun.build() returns a promise.
expectType(Bun.build({ entrypoints: ["hey"] })).is<Promise<Bun.BuildOutput>>();
expectType(Bun.build({ entrypoints: ["hey"], watch: false })).is<Promise<Bun.BuildOutput>>();
expectType<ReturnType<typeof Bun.build>>().is<Promise<Bun.BuildOutput>>();
expectType<Parameters<typeof Bun.build>>().is<[config: Bun.BuildConfig]>();

// A config that is typed as BuildConfig still gives a promise.
declare const buildConfig: Bun.BuildConfig;
expectType(Bun.build(buildConfig)).is<Promise<Bun.BuildOutput>>();
expectType(buildConfig.watch).is<boolean | undefined>();

// A `watch` that is only known when the program runs gives one or the other.
declare const watchFlag: boolean;
expectType(Bun.build({ entrypoints: ["hey"], watch: watchFlag })).is<Promise<Bun.BuildOutput> | Bun.BuildWatcher>();
const buildOptions = { entrypoints: ["hey"], watch: true };
expectType(Bun.build(buildOptions)).is<Promise<Bun.BuildOutput> | Bun.BuildWatcher>();
expectType(Bun.build({ entrypoints: ["hey"], watch: undefined })).is<Promise<Bun.BuildOutput>>();

// With `watch: true` it returns a BuildWatcher.
const buildWatcher = Bun.build({ entrypoints: ["hey"], outdir: "./dist", watch: true });
expectType(buildWatcher).is<Bun.BuildWatcher>();
expectType(buildWatcher.next()).is<Promise<IteratorResult<Bun.BuildOutput, undefined>>>();
expectType(buildWatcher.return()).is<Promise<IteratorResult<Bun.BuildOutput, undefined>>>();
expectType(buildWatcher.stop()).is<Promise<void>>();
expectType(buildWatcher[Symbol.asyncDispose]()).is<PromiseLike<void>>();

for await (const buildResult of buildWatcher) {
  expectType(buildResult).is<Bun.BuildOutput>();
}

for await (const buildResult of Bun.build({ entrypoints: ["hey"], watch: true, plugins: [] })) {
  expectType(buildResult.success).is<boolean>();
}

{
  await using disposedBuildWatcher = Bun.build({ entrypoints: ["hey"], watch: true });
  expectType(disposedBuildWatcher).is<Bun.BuildWatcher>();
}

Bun.build({
  entrypoints: ["hey"],
  // @ts-expect-error
  watch: "yes",
});

Bun.build({
  entrypoints: ["hey"],
  watch: true,
  // @ts-expect-error
  globalName: ["hey"],
});
