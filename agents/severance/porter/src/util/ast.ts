import { Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';

/**
 * Shared codemod primitives.
 *
 * Every operation here is idempotent and returns `false` when it found nothing
 * to do. That is what lets Porter be re-run on a half-ported repo without
 * producing a double-applied diff, which is the failure mode that makes
 * codemod tools untrustworthy.
 */

/**
 * Point every import of `from` at `to`, preserving the named bindings.
 *
 * Handles static imports, `require()`, and dynamic `import()`. Subpath imports
 * are remapped too: `@vercel/blob/client` -> `<to>/client`, unless an explicit
 * mapping is supplied.
 */
export function rewriteImportSpecifier(
  source: SourceFile,
  from: string,
  to: string,
  options: { subpaths?: Record<string, string> } = {},
): boolean {
  let changed = false;

  const remap = (specifier: string): string | null => {
    if (specifier === from) return to;
    if (specifier.startsWith(from + '/')) {
      const subpath = specifier.slice(from.length + 1);
      const explicit = options.subpaths?.[subpath];
      return explicit ?? to + '/' + subpath;
    }
    return null;
  };

  for (const decl of source.getImportDeclarations()) {
    const next = remap(decl.getModuleSpecifierValue());
    if (next === null) continue;
    decl.setModuleSpecifier(next);
    changed = true;
  }

  for (const decl of source.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (!specifier) continue;
    const next = remap(specifier);
    if (next === null) continue;
    decl.setModuleSpecifier(next);
    changed = true;
  }

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = expr.getText() === 'require';
    const isDynamic = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamic) continue;
    const arg = call.getArguments()[0];
    if (!arg || !arg.isKind(SyntaxKind.StringLiteral)) continue;
    const next = remap(arg.getLiteralValue());
    if (next === null) continue;
    arg.setLiteralValue(next);
    changed = true;
  }

  return changed;
}

/** True when the file imports anything from `specifier` (exact or subpath). */
export function importsFrom(source: SourceFile, specifier: string): boolean {
  return source
    .getImportDeclarations()
    .some((decl) => {
      const value = decl.getModuleSpecifierValue();
      return value === specifier || value.startsWith(specifier + '/');
    });
}

/**
 * Ensure `import { names } from 'specifier'` exists, merging into an existing
 * declaration for the same module rather than adding a second one.
 */
export function ensureNamedImport(
  source: SourceFile,
  specifier: string,
  names: string[],
): boolean {
  const existing = source
    .getImportDeclarations()
    .find((decl) => decl.getModuleSpecifierValue() === specifier);

  if (existing) {
    const present = new Set(existing.getNamedImports().map((n) => n.getName()));
    const missing = names.filter((name) => !present.has(name));
    if (missing.length === 0) return false;
    existing.addNamedImports(missing);
    return true;
  }

  source.addImportDeclaration({ moduleSpecifier: specifier, namedImports: names });
  return true;
}

/** Ensure `import name from 'specifier'`. */
export function ensureDefaultImport(
  source: SourceFile,
  specifier: string,
  name: string,
): boolean {
  const existing = source
    .getImportDeclarations()
    .find((decl) => decl.getModuleSpecifierValue() === specifier);

  if (existing) {
    if (existing.getDefaultImport()) return false;
    existing.setDefaultImport(name);
    return true;
  }

  source.addImportDeclaration({ moduleSpecifier: specifier, defaultImport: name });
  return true;
}

/** Drop every import of `specifier` (exact or subpath) from the file. */
export function removeImport(source: SourceFile, specifier: string): string[] {
  const removed: string[] = [];
  for (const decl of [...source.getImportDeclarations()]) {
    const value = decl.getModuleSpecifierValue();
    if (value !== specifier && !value.startsWith(specifier + '/')) continue;
    removed.push(
      ...decl.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName()),
      ...(decl.getDefaultImport() ? [decl.getDefaultImport()!.getText()] : []),
    );
    decl.remove();
  }
  return removed;
}

/**
 * Set `export const <name> = <value>`, where `value` is written as source text.
 * Returns false when the value is already what we want.
 */
export function setExportedConst(
  source: SourceFile,
  name: string,
  valueText: string,
): boolean {
  const decl = source.getVariableDeclaration(name);
  if (!decl) return false;
  const init = decl.getInitializer();
  if (init && init.getText() === valueText) return false;
  decl.setInitializer(valueText);
  return true;
}

/** Remove `export const <name> = ...` along with its statement. */
export function removeExportedConst(source: SourceFile, name: string): boolean {
  const decl = source.getVariableDeclaration(name);
  if (!decl) return false;
  const statement = decl.getVariableStatement();
  if (!statement) return false;
  statement.remove();
  return true;
}

/**
 * Find the object literal a `next.config.*` file exports.
 *
 * Covers the shapes that actually occur in the wild:
 *   const nextConfig = {...}; export default nextConfig
 *   export default {...}
 *   module.exports = {...}
 *   export default withPlugins({...})   / withMDX(nextConfig) / composePlugins(...)
 *
 * Returns null when the config is computed in a way Porter should not guess at —
 * in which case the transform reports a caveat instead of editing blind.
 */
export function findNextConfigObject(source: SourceFile): ObjectLiteralExpression | null {
  const fromExpression = (node: Node | undefined): ObjectLiteralExpression | null => {
    if (!node) return null;

    if (Node.isObjectLiteralExpression(node)) return node;

    // `export default nextConfig` — follow the identifier to its declaration.
    if (Node.isIdentifier(node)) {
      const decl = source.getVariableDeclaration(node.getText());
      const init = decl?.getInitializer();
      return init && Node.isObjectLiteralExpression(init) ? init : null;
    }

    // `withPlugins(config)` / `withMDX(config)` — the config is an argument.
    if (Node.isCallExpression(node)) {
      for (const arg of node.getArguments()) {
        const found = fromExpression(arg);
        if (found) return found;
      }
      return null;
    }

    // `satisfies NextConfig` / `as NextConfig`
    if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
      return fromExpression(node.getExpression());
    }

    return null;
  };

  const defaultExport = source.getExportAssignment((a) => !a.isExportEquals());
  if (defaultExport) {
    const found = fromExpression(defaultExport.getExpression());
    if (found) return found;
  }

  // CommonJS: module.exports = {...}
  for (const statement of source.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    const expr = statement.getExpression();
    if (!Node.isBinaryExpression(expr)) continue;
    if (expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    if (!/^module\.exports$/.test(expr.getLeft().getText())) continue;
    const found = fromExpression(expr.getRight());
    if (found) return found;
  }

  return null;
}

/**
 * Set `object.key = valueText`, creating the property if absent.
 * Returns false when the property already reads exactly that.
 */
export function upsertProperty(
  object: ObjectLiteralExpression,
  key: string,
  valueText: string,
): boolean {
  const existing = object.getProperty(key);

  if (existing && Node.isPropertyAssignment(existing)) {
    if (existing.getInitializer()?.getText() === valueText) return false;
    existing.setInitializer(valueText);
    return true;
  }

  if (existing) {
    // A shorthand or spread we should not silently clobber.
    return false;
  }

  object.addPropertyAssignment({ name: key, initializer: valueText });
  return true;
}

/** Get a nested object literal at `a.b.c`, creating intermediate objects. */
export function ensureNestedObject(
  object: ObjectLiteralExpression,
  path: string[],
): ObjectLiteralExpression | null {
  let current = object;
  for (const key of path) {
    const prop = current.getProperty(key);
    if (prop && Node.isPropertyAssignment(prop)) {
      const init = prop.getInitializer();
      if (!init || !Node.isObjectLiteralExpression(init)) return null;
      current = init;
      continue;
    }
    if (prop) return null;
    const added = current.addPropertyAssignment({ name: key, initializer: '{}' });
    const init = added.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) return null;
    current = init;
  }
  return current;
}

/** Read a string-valued property, if it is a plain string literal. */
export function readStringProperty(
  object: ObjectLiteralExpression,
  key: string,
): string | null {
  const prop = object.getProperty(key);
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init || !Node.isStringLiteral(init)) return null;
  return init.getLiteralValue();
}

/**
 * Remove `export const runtime = 'edge'` and nothing else.
 *
 * Matching on the name alone would delete an unrelated local called `runtime`,
 * or an explicit `'nodejs'` pin the author chose on purpose.
 */
export function removeEdgeRuntimeExport(source: SourceFile): boolean {
  let changed = false;
  for (const decl of source.getVariableDeclarations()) {
    if (decl.getName() !== 'runtime') continue;
    const statement = decl.getVariableStatement();
    if (!statement || !statement.isExported()) continue;
    const init = decl.getInitializer();
    if (!init || !Node.isStringLiteral(init) || init.getLiteralValue() !== 'edge') continue;
    statement.remove();
    changed = true;
  }
  return changed;
}

/** Remove `runtime: 'edge'` from `export const config = {...}` (middleware). */
export function removeEdgeRuntimeFromConfig(source: SourceFile): boolean {
  const init = source.getVariableDeclaration('config')?.getInitializer();
  if (!init || !Node.isObjectLiteralExpression(init)) return false;
  const runtime = init.getProperty('runtime');
  if (!runtime || !Node.isPropertyAssignment(runtime)) return false;
  const value = runtime.getInitializer();
  if (!value || !Node.isStringLiteral(value) || value.getLiteralValue() !== 'edge') return false;
  runtime.remove();
  return true;
}

/**
 * Delete JSX elements by tag name, taking the whole line with them when the
 * element is alone on it. Replacing with `{null}` would leave litter in every
 * layout Porter touches.
 */
export function removeJsxElements(source: SourceFile, tagNames: string[]): boolean {
  const wanted = new Set(tagNames);
  let changed = false;

  for (;;) {
    const node =
      source
        .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
        .find((n) => wanted.has(n.getTagNameNode().getText())) ??
      source
        .getDescendantsOfKind(SyntaxKind.JsxElement)
        .find((n) => wanted.has(n.getOpeningElement().getTagNameNode().getText()));
    if (!node) break;

    const text = source.getFullText();
    let start = node.getStart();
    let end = node.getEnd();
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nl = text.indexOf('\n', end);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
      start = lineStart;
      end = nl === -1 ? text.length : nl + 1;
    }
    source.replaceText([start, end], '');
    changed = true;
  }
  return changed;
}

/** True when the config file is an ES module (`export default`) rather than CommonJS. */
export function isEsmConfig(source: SourceFile): boolean {
  return source.getExportAssignments().some((a) => !a.isExportEquals());
}
