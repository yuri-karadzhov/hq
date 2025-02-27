import {
  getBrowsersList,
  getInputSourceMap,
  getProjectModulePath,
  getScriptExtensionByAttrs,
  getStyleExtensionByAttrs,
} from './utils.mjs';
import babel from '@babel/core';
import babelDecoratorMetadata from '@hqjs/babel-plugin-add-decorators-metadata';
import babelMinifyDeadCode from 'babel-plugin-minify-dead-code-elimination';
import babelPresetEnv from '@babel/preset-env';
import babelPresetFlow from '@babel/preset-flow';
import babelPresetReact from '@babel/preset-react';
import babelSyntaxImportMeta from '@babel/plugin-syntax-import-meta';
import babelTransformClassProperties from '@babel/plugin-proposal-class-properties';
import babelTransformCssImport from '@hqjs/babel-plugin-transform-css-imports';
import babelTransformDecorators from '@babel/plugin-proposal-decorators';
import babelTransformDefine from '@hqjs/babel-plugin-transform-define';
import babelTransformExportDefault from '@babel/plugin-proposal-export-default-from';
import babelTransformExportNamespace from '@babel/plugin-proposal-export-namespace-from';
import babelTransformJsonImport from '@hqjs/babel-plugin-transform-json-imports';
import babelTransformMixedImports from '@hqjs/babel-plugin-transform-mixed-imports';
import babelTransformModules from '@hqjs/babel-plugin-transform-modules';
import babelTransformNameImports from '@hqjs/babel-plugin-transform-name-imports';
import babelTransformNamedImportToDestruct from '@hqjs/babel-plugin-transform-named-import-to-destructure';
import babelTransformParameterDecorators from '@hqjs/babel-plugin-transform-parameter-decorators';
import babelTransformPaths from '@hqjs/babel-plugin-transform-paths';
import babelTransformPrivateMethods from '@babel/plugin-proposal-private-methods';
import babelTransformTypescript from '@hqjs/babel-plugin-transform-typescript';
import babelTypeMetadata from '@hqjs/babel-plugin-add-type-metadata';
import compileCSS from './css.mjs';
import patchAngularCompiler from '@hqjs/babel-plugin-patch-angular-fesm5-compiler';
import path from 'path';

const getBabelSetup = (ctx, skipHQTrans) => {
  const { ua } = ctx.store;
  const isTSX = ctx.stats.ext === '.tsx';
  const isTS = ctx.stats.ext === '.ts';
  const tsOptions = { legacy: isTS || isTSX };
  if (!isTS && !isTSX) tsOptions.decoratorsBeforeExport = true;
  const prePlugins = [
    babelSyntaxImportMeta,
    babelTransformExportDefault,
    babelTransformExportNamespace,
    [ babelTransformDecorators, tsOptions ],
    babelTransformParameterDecorators,
    [ babelTransformClassProperties, { loose: true }],
    [ babelTransformPrivateMethods, { loose: true }],
    [ babelTransformDefine, {
      // TODO: make it conditional
      'import.meta': { url: ctx.path },
      'process.env.NODE_ENV': 'development',
      'typeof window': 'object',
    }],
    babelMinifyDeadCode,
    babelTransformModules,
  ];
  const plugins = [
    babelSyntaxImportMeta,
    babelTransformMixedImports,
    [ babelTransformPaths, {
      baseURI: ctx.store.baseURI,
      dirname: ctx.dirname,
    }],
    [ babelTransformNameImports, { resolve: { vue: 'vue/dist/vue.esm.js' } }],
    [ babelTransformNamedImportToDestruct, {
      baseURI: ctx.store.baseURI,
      map: '.map*',
    }],
    babelTransformCssImport,
    [ babelTransformJsonImport, { dirname: ctx.stats.dirname }],
  ];

  if (ctx.path.endsWith('compiler/fesm5/compiler.js')) {
    plugins.unshift(patchAngularCompiler);
  }
  const isPoly = ctx.path.startsWith('/node_modules/core-js/');
  const presets = [
    [ babelPresetEnv, {
      corejs: isPoly ? undefined : { proposals: true, version: 3 },
      ignoreBrowserslistConfig: false,
      loose: true,
      modules: false,
      shippedProposals: true,
      targets: { browsers: getBrowsersList(ua) },
      useBuiltIns: isPoly ? false : 'usage',
    }],
  ];
  if (isTS || isTSX) {
    prePlugins.unshift(
      [ babelTransformTypescript, {
        allowNamespaces: true,
        isTSX,
        jsxPragma: 'React',
        removeUnusedImports: !skipHQTrans && !isTSX,
      }],
      babelTypeMetadata,
      babelDecoratorMetadata
    );
    if (isTSX) {
      presets.push([
        babelPresetReact,
        { development: true },
      ]);
    }
  } else {
    presets.push([
      babelPresetReact,
      { development: true },
    ], babelPresetFlow);
  }

  return { plugins: skipHQTrans ? [] : plugins, prePlugins, presets };
};

const precompileCoffee = async (ctx, content, sourceMap) => {
  const { default: CoffeeScript } = await import('coffeescript');
  const inputContent = CoffeeScript.compile(content, {
    header: false,
    inlineMap: true,
    sourceMap,
  });
  const inputSourceMap = await getInputSourceMap(ctx.srcPath, inputContent);
  return { inputContent, inputSourceMap };
};

const precompileVue = async (ctx, content) => {
  const { default: Vue } = await import('@vue/component-compiler');
  const compiler = Vue.createDefaultCompiler();
  const descriptor = compiler.compileToDescriptor(ctx.path, content);
  const res = Vue.assemble(compiler, ctx.path, descriptor);
  return { inputContent: res.code, inputSourceMap: res.map };
};

const precompileSvelte = async (ctx, content) => {
  let scriptIndex = 0;
  let styleIndex = 0;
  // TODO: check svelte version from project package.json
  // TODO: check and add necessary compiller options for svelte version 2
  const { default: svelte } = await import(getProjectModulePath(ctx.app.root, 'svelte/compiler.js'));
  const pre = await svelte.preprocess(content, {
    // TODO: support script preprocessors, do not transform imports
    script({ content: scriptContent, attributes }) {
      const ext = getScriptExtensionByAttrs(attributes);
      if (![ '.ts', '.tsx', '.coffee', '.jsx' ].includes(ext)) return null;
      // TODO: check if sourcemaps can be usefull for inline scripts
      return compileJS({
        ...ctx,
        path: `${ctx.path}-${scriptIndex++}${ext}`,
        stats: {
          ...ctx.stats,
          ext,
        },
      }, scriptContent, false, { skipHQTrans: true, skipSM: true });
    },
    style({ content: styleContent, attributes }) {
      const ext = getStyleExtensionByAttrs(attributes);
      if (![ '.sass', '.scss', '.less' ].includes(ext)) return null;
      return compileCSS({
        ...ctx,
        path: `${ctx.path}$${styleIndex++}${ext}`,
        stats: {
          ...ctx.stats,
          ext,
        },
      }, styleContent, false, { skipSM: true });
    },
  });
  const res = svelte.compile(pre.code, {
    filename: ctx.path,
    format: 'esm',
    name: path.basename(ctx.path, '.svelte'),
  });
  const inputContent = res.js.code;
  const inputSourceMap = res.js.map;
  inputSourceMap.sources[0] = `${ctx.originalPath}.map*`;
  return { inputContent, inputSourceMap };
};

const precompile = async (ctx, content, sourceMap) => {
  if (ctx.stats.ext === '.coffee') return precompileCoffee(ctx, content, sourceMap);
  if (ctx.stats.ext === '.vue') return precompileVue(ctx, content);
  if (ctx.stats.ext === '.svelte') return precompileSvelte(ctx, content);
  return { inputContent: content, inputSourceMap: sourceMap };
};

const compileJS = async (ctx, content, sourceMap, { skipHQTrans = false, skipSM = false } = {}) => {
  const { inputContent, inputSourceMap } = await precompile(ctx, content, sourceMap);

  const { plugins, prePlugins, presets } = getBabelSetup(ctx, skipHQTrans);

  const { ast } = await babel.transformAsync(inputContent, {
    ast: true,
    babelrc: false,
    code: false,
    comments: true,
    compact: false,
    configFile: false,
    extends: ctx.app.babelrc,
    filename: ctx.path,
    inputSourceMap,
    plugins: prePlugins,
    presets,
    sourceFileName: `${ctx.originalPath}.map*`,
    sourceMaps: !skipSM,
  });

  const { code, map } = await babel.transformFromAstAsync(ast, inputContent, {
    ast: false,
    babelrc: false,
    code: true,
    comments: true,
    compact: false,
    configFile: false,
    filename: ctx.path,
    inputSourceMap,
    plugins,
    presets: [],
    sourceFileName: `${ctx.originalPath}.map*`,
    sourceMaps: !skipSM,
  });

  const codeSM = skipSM ? code : `${code}\n//# sourceMappingURL=${ctx.path}.map`;
  return { code: codeSM, map };
};

export default compileJS;
