const path = require("path");
const nodeExternals = require("webpack-node-externals");

/**
 * Optional native-acceleration packages that are loaded by their consumers
 * inside try/catch with a pure-JS fallback (e.g. ws / socket.io). We never want
 * webpack to bundle a `.node` binary, so in bundle mode these stay external.
 * At runtime they are simply absent and the consumer falls back to pure JS.
 */
const OPTIONAL_NATIVE_EXTERNALS = ["bufferutil", "utf-8-validate", "cpu-features"];

/**
 * BUNDLE=1 => production packaging: inline the entire dependency tree (every
 * npm package + all language packs via the static `@languages` imports) so the
 * emitted app.js runs with bare `node` and no `node_modules` installed.
 * Otherwise (dev) keep deps external for fast incremental rebuilds.
 */
const BUNDLE = process.env.BUNDLE === "1";

/**
 * Externalize native `.node` binary requires (e.g. ssh2's `sshcrypto.node`) as
 * CommonJS so webpack emits `module.exports = require("...")` instead of trying
 * to parse the binary (build error) or emitting invalid JS. These binaries are
 * pure acceleration: their consumers load them inside `try { } catch { }` and
 * fall back to pure JS. At runtime the require throws MODULE_NOT_FOUND (no
 * node_modules shipped) and the consumer catches it -> pure-JS path.
 */
function externalNativeNodeBinary({ request }, callback) {
  if (typeof request === "string" && /\.node$/.test(request)) {
    return callback(null, { commonjs: request });
  }
  callback();
}

/**
 * @type {import('webpack').Configuration}
 */
module.exports = {
  mode: "production",
  entry: "./src/app.ts",
  module: {
    rules: [
      {
        test: /\.ts/,
        use: "ts-loader",
        exclude: /node_modules/
      },
      {
        // formidable v2 (nested inside koa-body) loads its plugins via a dynamic
        // `require(path.join(...))` that webpack cannot trace. This loader rewrites
        // it into a statically-analyzable form so the plugin files get bundled into
        // app.js. See webpack/formidable-plugin.loader.js.
        test: /node_modules[\\/](?:koa-body[\\/]node_modules[\\/])?formidable[\\/]src[\\/]Formidable\.js$/,
        loader: path.resolve(__dirname, "webpack/formidable-plugin.loader.js")
      }
    ]
  },
  target: "node",
  plugins: [{ apply(compiler) {
    compiler.hooks.beforeCompile.tap("NomadNumenAdapter", () => {require("node:child_process").execFileSync(process.execPath,[path.resolve(__dirname,"../../../apps/numen-adapter/build.cjs")],{stdio:"inherit",windowsHide:true});require("node:child_process").execFileSync(process.execPath,[path.resolve(__dirname,"../../../apps/gateway/build.cjs")],{stdio:"inherit",windowsHide:true});});
    compiler.hooks.thisCompilation.tap("NomadNumenAdapter", compilation => {compilation.hooks.processAssets.tap({name:"NomadNumenAdapter",stage:compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL},()=>{const dir=path.resolve(__dirname,"../../../apps/numen-adapter/dist"),fs=require("node:fs");const manifest=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));for(const artifact of manifest.artifacts){const bytes=fs.readFileSync(path.join(dir,artifact.file));compilation.emitAsset(artifact.file,new compiler.webpack.sources.RawSource(bytes));}compilation.emitAsset("nomad-numen-adapters.json",new compiler.webpack.sources.RawSource(JSON.stringify(manifest)));const gateway=path.resolve(__dirname,"../../../apps/gateway");for(const file of ["runtime.cjs","prepare.cjs","backend.cjs","vanilla.cjs","dist/nomad-gateway.jar","dist/manifest.json",...fs.readdirSync(path.join(gateway,"dist/dependencies")).map(file=>"dist/dependencies/"+file)])compilation.emitAsset("gateway/"+file,new compiler.webpack.sources.RawSource(fs.readFileSync(path.join(gateway,file))));});});
  }}],
  devtool: "source-map",
  optimization: {
    chunkIds: "named",
    minimize: false,
    mangleExports: false,
    moduleIds: "named"
  },
  externalsPresets: { node: true },
  externals: BUNDLE
    ? [...OPTIONAL_NATIVE_EXTERNALS, externalNativeNodeBinary]
    : [
        nodeExternals({
          allowlist: ["mcsmanager-common"]
        })
      ],
  output: {
    filename: "app.js",
    path: path.resolve(__dirname, "production")
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      "@languages": path.resolve(__dirname, "../languages"),
      "mcsmanager-common": path.resolve(__dirname, "../common/src/index.ts")
    }
  }
};
