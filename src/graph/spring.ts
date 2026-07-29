/**
 * Spring dependency-injection edges — a Java graph-enrichment pass on top of the import graph.
 *
 * Spring wires beans together at runtime, and the most valuable coupling it creates is invisible to
 * imports: a `@Service` that injects a `PaymentGateway` *interface* imports the interface, never the
 * concrete `StripeGateway` bean Spring wires in — yet changing that impl changes the service's
 * behaviour. An import-only graph misses it. This pass adds an edge from an injecting bean to every
 * concrete bean that could satisfy the injection (an interface's implementations, a concrete bean of
 * the type, or the `@Configuration` that produces it via `@Bean`), so blast radius and test
 * selection account for DI wiring.
 *
 * When an injection point carries `@Qualifier("name")` (or the field/parameter otherwise names a
 * specific bean), the candidate set is narrowed to the bean(s) whose name matches — a bean's names
 * being its default (decapitalized class name), its stereotype value (`@Service("name")`), or a
 * class-level `@Qualifier`. A qualifier that matches nothing in the repo is ignored (we keep all
 * candidates) rather than dropping the edge — see the over-approximation note below.
 *
 * Deterministic static analysis — never a guess (docs/architecture.md, principle 2). Resolution is
 * by simple type name, a deliberate, conservative over-approximation: a name collision across
 * packages can only *add* edges, and blast radius is already a safe over-approximation (a superset
 * of tests is fine, a missed test is not). `@Qualifier` narrowing *removes* edges, so it only ever
 * fires when a concrete matching bean is found — never leaving an injection with no candidate.
 *
 * Because these edges are inherently cross-file (an impl in file A changes an injector in file B),
 * they are computed only in a full `buildFileGraph`; any `.java` change forces a full rebuild rather
 * than an incremental one (see graph/cache.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { parseJava } from "./java-scanner.js";
import { discoverJavaLayout, moduleOf } from "./java-modules.js";
import { WHOLE_MODULE, type EdgeKind } from "./scanner.js";

/** Class annotations that mark a Spring bean (a candidate injection target and injector). */
const STEREOTYPES = new Set([
  "Component", "Service", "Repository", "Controller", "RestController",
  "Configuration", "ControllerAdvice", "RestControllerAdvice",
]);
/** Field/parameter annotations that mark an injection point. */
const INJECT_ANNOTATIONS = new Set(["Autowired", "Inject", "Resource"]);
/** Lombok class annotations that generate an injecting constructor from fields. */
const LOMBOK_ALL = new Set(["AllArgsConstructor"]);
const LOMBOK_REQUIRED = new Set(["RequiredArgsConstructor", "Data", "Value"]);
/** Wrapper/collection and java.lang type names that are never the injected bean themselves. */
const NOT_A_BEAN = new Set([
  "List", "Set", "Collection", "Map", "Optional", "Provider", "ObjectProvider", "ObjectFactory",
  "Stream", "Iterable", "Iterator", "Comparator", "Array", "Supplier",
  "String", "Integer", "Long", "Double", "Float", "Boolean", "Byte", "Short", "Character",
  "Object", "Number", "CharSequence", "BigDecimal", "BigInteger", "Class", "Void",
  "T", "E", "K", "V", "R", "U", "S",
]);

/** One injection point: the candidate bean type names it needs, and its `@Qualifier`, if any. */
interface InjectionPoint {
  types: string[];
  qualifier?: string;
}
/** A bean that can satisfy an injection: its file, the names it answers to (for @Qualifier), and the
 *  module it lives in (candidates are scoped to the injector's module — a same-named type in another
 *  module isn't a candidate; see java-modules.ts). */
interface BeanRef {
  file: string;
  names: string[];
  module: string;
}
interface JavaTypeMeta {
  file: string;
  /** the type's simple name */
  name: string;
  /** interfaces + superclass it implements/extends (simple names) */
  supers: string[];
  /** whether the type is a Spring bean (carries a stereotype) */
  isBean: boolean;
  /** the names this bean answers to: default (decapitalized), stereotype value, class @Qualifier */
  beanNames: string[];
  /** the bean's injection points (constructor/@Autowired/Lombok/@Bean-method params + fields) */
  injections: InjectionPoint[];
  /** @Bean-produced types this (config) bean is a factory for, each with the bean's names */
  produces: { type: string; names: string[] }[];
}

const simpleName = (text: string): string => text.split(".").pop() ?? text;

/** All descendant nodes of a given type (manual walk — matches the other tree-sitter scanners). */
function descendantsOfType(node: Node, type: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (n.type === type) out.push(n);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(node);
  return out;
}

function modifiersOf(node: Node): Node | null {
  return node.namedChildren.find((c) => c?.type === "modifiers") ?? null;
}

function hasModifier(modifiers: Node | null, keyword: string): boolean {
  return modifiers ? modifiers.children.some((c) => c?.type === keyword) : false;
}

/** Annotation simple-names on a `modifiers` node (both `@Marker` and `@Anno(...)` forms). */
function annotationNames(modifiers: Node | null): Set<string> {
  const names = new Set<string>();
  if (!modifiers) return names;
  for (const anno of annotationNodes(modifiers)) {
    const id = anno.namedChildren.find((c) => c?.type === "identifier" || c?.type === "scoped_identifier");
    if (id) names.add(simpleName(id.text));
  }
  return names;
}

function annotationNodes(modifiers: Node | null): Node[] {
  if (!modifiers) return [];
  return modifiers.namedChildren.filter((c): c is Node => c?.type === "marker_annotation" || c?.type === "annotation");
}

/** The `@Name(...)` annotation node on `modifiers`, by simple name. */
function findAnnotation(modifiers: Node | null, name: string): Node | undefined {
  return annotationNodes(modifiers).find((anno) => {
    const id = anno.namedChildren.find((c) => c?.type === "identifier" || c?.type === "scoped_identifier");
    return id ? simpleName(id.text) === name : false;
  });
}

/** The string argument of an annotation (`@Service("x")` / `@Qualifier(value="x")` → "x"). */
function stringArg(anno: Node | undefined): string | undefined {
  if (!anno) return undefined;
  const argList = anno.namedChildren.find((c) => c?.type === "annotation_argument_list");
  return argList ? descendantsOfType(argList, "string_fragment")[0]?.text : undefined;
}

/** The `@Qualifier` value at an injection point (a field/parameter's modifiers), if any. */
function qualifierOf(modifiers: Node | null): string | undefined {
  return stringArg(findAnnotation(modifiers, "Qualifier"));
}

/** Spring's default bean name: java.beans.Introspector.decapitalize — lowercase the first char
 *  unless the first two are both upper case (so `URLParser` stays `URLParser`). */
function decapitalize(name: string): string {
  if (name.length === 0) return name;
  if (name.length > 1 && name[0] === name[0]!.toUpperCase() && name[1] === name[1]!.toUpperCase()) return name;
  return name[0]!.toLowerCase() + name.slice(1);
}

/** The names a bean answers to for @Qualifier matching. Includes the default and the raw class name
 *  (harmless extra — over-matching only adds edges), plus any stereotype/@Qualifier value. */
function beanNamesOf(className: string, classModifiers: Node | null): string[] {
  const names = new Set([decapitalize(className), className]);
  for (const st of STEREOTYPES) {
    const v = stringArg(findAnnotation(classModifiers, st));
    if (v) names.add(v);
  }
  const q = stringArg(findAnnotation(classModifiers, "Qualifier"));
  if (q) names.add(q);
  return [...names];
}

/** Collect the bean type names in an injected type expression: unwrap generics/arrays/`List<T>` and
 *  drop wrapper and java.lang names, so `List<Notifier>` → {Notifier}, `PaymentGateway` → {…}. */
function collectInjectedTypes(typeNode: Node | null, out: Set<string>): void {
  if (!typeNode) return;
  const t = typeNode.type;
  if (t === "type_identifier") {
    if (!NOT_A_BEAN.has(typeNode.text)) out.add(typeNode.text);
  } else if (t === "scoped_type_identifier") {
    const n = simpleName(typeNode.text);
    if (!NOT_A_BEAN.has(n)) out.add(n);
  } else if (t === "generic_type" || t === "array_type" || t === "type_arguments" || t === "annotated_type") {
    for (const c of typeNode.namedChildren) collectInjectedTypes(c, out);
  }
  // primitives, void_type, etc. — not beans
}

function paramType(param: Node): Node | null {
  return param.childForFieldName("type") ?? param.namedChildren.find((c) => c?.type.endsWith("type") || c?.type.endsWith("type_identifier")) ?? null;
}

/** An injection point from a formal parameter: its bean types + the parameter's own @Qualifier. */
function pointFromParam(param: Node): InjectionPoint | null {
  const types = new Set<string>();
  collectInjectedTypes(paramType(param), types);
  if (types.size === 0) return null;
  const qualifier = qualifierOf(modifiersOf(param));
  return { types: [...types], ...(qualifier ? { qualifier } : {}) };
}

function paramsOf(member: Node): Node[] {
  return (member.childForFieldName("parameters")?.namedChildren ?? []).filter((p): p is Node => p?.type === "formal_parameter");
}

/** Extract the injectable Spring metadata for one Java file (its top-level types). */
function extractTypes(file: string, content: string): JavaTypeMeta[] {
  const root = parseJava(content);
  if (!root) return [];
  const types: JavaTypeMeta[] = [];

  for (const decl of root.namedChildren) {
    if (!decl || decl.type !== "class_declaration") continue; // beans are classes
    const name = decl.childForFieldName("name")?.text;
    if (!name) continue;
    const classMods = modifiersOf(decl);
    const classAnnos = annotationNames(classMods);
    const isBean = [...classAnnos].some((a) => STEREOTYPES.has(a));

    const supers: string[] = [];
    const superInterfaces = decl.namedChildren.find((c) => c?.type === "super_interfaces");
    if (superInterfaces) for (const ti of descendantsOfType(superInterfaces, "type_identifier")) supers.push(ti.text);
    const superclass = decl.childForFieldName("superclass") ?? decl.namedChildren.find((c) => c?.type === "superclass");
    if (superclass) for (const ti of descendantsOfType(superclass, "type_identifier")) supers.push(ti.text);

    const injections: InjectionPoint[] = [];
    const produces: { type: string; names: string[] }[] = [];
    const body = decl.namedChildren.find((c) => c?.type === "class_body");
    if (isBean && body) {
      const lombokAll = [...classAnnos].some((a) => LOMBOK_ALL.has(a));
      const lombokReq = [...classAnnos].some((a) => LOMBOK_REQUIRED.has(a));
      for (const member of body.namedChildren) {
        if (!member) continue;
        if (member.type === "constructor_declaration") {
          // A bean's constructor parameters are injected (Spring auto-wires the sole constructor).
          for (const p of paramsOf(member)) {
            const point = pointFromParam(p);
            if (point) injections.push(point);
          }
        } else if (member.type === "field_declaration") {
          const mods = modifiersOf(member);
          const annotated = [...annotationNames(mods)].some((a) => INJECT_ANNOTATIONS.has(a));
          const lombokField = lombokAll || (lombokReq && hasModifier(mods, "final"));
          if (annotated || lombokField) {
            const t = new Set<string>();
            collectInjectedTypes(member.childForFieldName("type"), t);
            if (t.size > 0) {
              const qualifier = qualifierOf(mods);
              injections.push({ types: [...t], ...(qualifier ? { qualifier } : {}) });
            }
          }
        } else if (member.type === "method_declaration") {
          const mods = modifiersOf(member);
          const annos = annotationNames(mods);
          const isSetter = [...annos].some((a) => INJECT_ANNOTATIONS.has(a));
          const isBeanMethod = annos.has("Bean");
          if (isSetter || isBeanMethod) {
            for (const p of paramsOf(member)) {
              const point = pointFromParam(p);
              if (point) injections.push(point);
            }
          }
          if (isBeanMethod) {
            const ret = member.childForFieldName("type");
            if (ret?.type === "type_identifier") {
              const methodName = member.childForFieldName("name")?.text;
              const names = [stringArg(findAnnotation(mods, "Bean")), stringArg(findAnnotation(mods, "Qualifier")), methodName]
                .filter((n): n is string => Boolean(n));
              produces.push({ type: ret.text, names });
            }
          }
        }
      }
    }
    types.push({ file, name, supers, isBean, beanNames: isBean ? beanNamesOf(name, classMods) : [], injections, produces });
  }
  return types;
}

/**
 * Compute the Spring DI edges for a repo's Java files and merge them into the graph's import maps.
 * Adds an edge (symbol "*") from each injecting bean file to every bean file that could satisfy an
 * injection — narrowed by `@Qualifier` when one is present and matches a known bean. Mutates
 * `imports`/`importSymbols`.
 */
export function applySpringEdges(
  root: string,
  javaRelFiles: string[],
  imports: Map<string, Set<string>>,
  importSymbols: Map<string, Map<string, Set<string>>>,
  edgeKind: Map<string, Map<string, EdgeKind>>,
): void {
  const all: JavaTypeMeta[] = [];
  for (const rel of javaRelFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(root, rel), "utf8");
    } catch {
      continue;
    }
    all.push(...extractTypes(rel, content));
  }

  // The module each Java file belongs to — candidates are matched within a module, so two same-named
  // types in different modules don't become each other's DI candidates (java-modules.ts).
  const layout = discoverJavaLayout(root);
  const moduleByFile = new Map<string, string>();
  const moduleFor = (rel: string): string => {
    let m = moduleByFile.get(rel);
    if (m === undefined) {
      m = moduleOf(layout, path.resolve(root, rel)).root;
      moduleByFile.set(rel, m);
    }
    return m;
  };

  // Repo-wide bean index: a simple type name → the beans that satisfy an injection of it. A concrete
  // bean class contributes its own name; a bean contributes every interface/superclass it implements
  // (so an interface injection resolves to its implementations); an @Bean factory contributes its
  // produced types. Each entry carries the bean's names (for @Qualifier) and module (for scoping).
  const beanIndex = new Map<string, BeanRef[]>();
  const add = (typeName: string, ref: BeanRef): void => {
    let list = beanIndex.get(typeName);
    if (!list) {
      list = [];
      beanIndex.set(typeName, list);
    }
    list.push(ref);
  };
  for (const t of all) {
    if (!t.isBean) continue;
    const module = moduleFor(t.file);
    const self: BeanRef = { file: t.file, names: t.beanNames, module };
    add(t.name, self);
    for (const s of t.supers) add(s, self);
    for (const p of t.produces) add(p.type, { file: t.file, names: p.names, module });
  }

  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    let deps = imports.get(from);
    if (!deps) {
      deps = new Set();
      imports.set(from, deps);
    }
    const existed = deps.has(to); // did a real import / adjacency edge already exist here?
    deps.add(to);
    let syms = importSymbols.get(from);
    if (!syms) {
      syms = new Map();
      importSymbols.set(from, syms);
    }
    let set = syms.get(to);
    if (!set) {
      set = new Set();
      syms.set(to, set);
    }
    set.add(WHOLE_MODULE);

    // Label the edge "di" when it's newly created by the DI pass, or when it upgrades a bare
    // package-adjacency edge. A pre-existing real "import" edge (no kind stored) outranks DI and stays.
    const cur = edgeKind.get(from)?.get(to);
    if (!existed || cur === "package") {
      let kinds = edgeKind.get(from);
      if (!kinds) {
        kinds = new Map();
        edgeKind.set(from, kinds);
      }
      kinds.set(to, "di");
    }
  };

  for (const t of all) {
    if (!t.isBean) continue;
    const injectorModule = moduleFor(t.file);
    for (const ip of t.injections) {
      const candidates: BeanRef[] = [];
      // Only beans in the SAME module can satisfy the injection — a same-named type in a foreign
      // module (a samples monorepo, a sibling service) is not a candidate.
      for (const type of ip.types) {
        for (const ref of beanIndex.get(type) ?? []) if (ref.module === injectorModule) candidates.push(ref);
      }
      // @Qualifier narrows to the matching bean(s). If it matches nothing here (the qualifier names
      // a bean keel can't see), keep all candidates rather than drop the edge — stay conservative.
      let chosen = candidates;
      if (ip.qualifier) {
        const matched = candidates.filter((r) => r.names.includes(ip.qualifier!));
        if (matched.length > 0) chosen = matched;
      }
      for (const r of chosen) addEdge(t.file, r.file);
    }
  }
}

/** The repo-relative posix paths of every `.java` file in the graph's file set. */
export function javaFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".java"));
}
