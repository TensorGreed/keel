/**
 * Spring dependency-injection edges — a Java graph-enrichment pass on top of the import graph.
 *
 * Spring wires beans together at runtime, and the most valuable coupling it creates is invisible to
 * imports: a `@Service` that injects a `PaymentGateway` *interface* imports the interface, never the
 * concrete `StripeGateway` bean Spring actually wires in — yet changing that impl changes the
 * service's behaviour. An import-only graph misses it. This pass adds an edge from an injecting bean
 * to every concrete bean that could satisfy the injection (an interface's implementations, or a
 * `@Bean`-produced type's factory), so blast radius and test selection account for DI wiring.
 *
 * Deterministic static analysis — never a guess (docs/architecture.md, principle 2). It reads the
 * beans (stereotype annotations), their injection points (constructor params, `@Autowired`
 * fields/setters, Lombok-generated constructors, `@Bean` method params), and the interface/superclass
 * each bean implements, then resolves injected type names against a repo-wide bean index.
 *
 * Because these edges are inherently cross-file (an impl in file A changes an injector in file B),
 * they are computed only in a full `buildFileGraph`; any `.java` change forces a full rebuild rather
 * than an incremental one (see graph/cache.ts). Resolution is by simple type name — a deliberate,
 * conservative over-approximation: a name collision across packages can only *add* edges, and blast
 * radius is already a safe over-approximation (a superset of tests is fine, a missed test is not).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { parseJava } from "./java-scanner.js";
import { WHOLE_MODULE } from "./scanner.js";

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

interface JavaTypeMeta {
  file: string;
  /** the type's simple name */
  name: string;
  /** interfaces + superclass it implements/extends (simple names) */
  supers: string[];
  /** whether the type is a Spring bean (carries a stereotype) */
  isBean: boolean;
  /** simple type names this bean injects (constructor/@Autowired/Lombok/@Bean-method params) */
  injects: Set<string>;
  /** @Bean method return types this (config) bean produces — a factory for those types */
  produces: string[];
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

/** Annotation simple-names on a `modifiers` node (both `@Marker` and `@Anno(...)` forms). */
function annotationNames(modifiers: Node | null): Set<string> {
  const names = new Set<string>();
  if (!modifiers) return names;
  for (const child of modifiers.namedChildren) {
    if (child && (child.type === "marker_annotation" || child.type === "annotation")) {
      const id = child.namedChildren.find((c) => c?.type === "identifier" || c?.type === "scoped_identifier");
      if (id) names.add(simpleName(id.text));
    }
  }
  return names;
}

function modifiersOf(node: Node): Node | null {
  return node.namedChildren.find((c) => c?.type === "modifiers") ?? null;
}

function hasModifier(modifiers: Node | null, keyword: string): boolean {
  return modifiers ? modifiers.children.some((c) => c?.type === keyword) : false;
}

/** Collect the bean type names in an injected type expression: unwrap generics/arrays/`List<T>` and
 *  drop wrapper and java.lang names, so `List<Notifier>` → {Notifier}, `PaymentGateway` → {gateway}. */
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

/** Extract the injectable Spring metadata for one Java file (its top-level types). */
function extractTypes(file: string, content: string): JavaTypeMeta[] {
  const root = parseJava(content);
  if (!root) return [];
  const types: JavaTypeMeta[] = [];

  for (const decl of root.namedChildren) {
    if (!decl || decl.type !== "class_declaration") continue; // beans are classes
    const name = decl.childForFieldName("name")?.text;
    if (!name) continue;
    const classAnnos = annotationNames(modifiersOf(decl));
    const isBean = [...classAnnos].some((a) => STEREOTYPES.has(a));

    const supers: string[] = [];
    const superInterfaces = decl.namedChildren.find((c) => c?.type === "super_interfaces");
    if (superInterfaces) for (const ti of descendantsOfType(superInterfaces, "type_identifier")) supers.push(ti.text);
    const superclass = decl.childForFieldName("superclass") ?? decl.namedChildren.find((c) => c?.type === "superclass");
    if (superclass) for (const ti of descendantsOfType(superclass, "type_identifier")) supers.push(ti.text);

    const injects = new Set<string>();
    const produces: string[] = [];
    const body = decl.namedChildren.find((c) => c?.type === "class_body");
    if (isBean && body) {
      const lombokAll = [...classAnnos].some((a) => LOMBOK_ALL.has(a));
      const lombokReq = [...classAnnos].some((a) => LOMBOK_REQUIRED.has(a));
      for (const member of body.namedChildren) {
        if (!member) continue;
        if (member.type === "constructor_declaration") {
          // A bean's constructor parameters are injected (Spring auto-wires the sole constructor).
          for (const p of member.childForFieldName("parameters")?.namedChildren ?? []) {
            if (p?.type === "formal_parameter") collectInjectedTypes(paramType(p), injects);
          }
        } else if (member.type === "field_declaration") {
          const mods = modifiersOf(member);
          const annotated = [...annotationNames(mods)].some((a) => INJECT_ANNOTATIONS.has(a));
          const lombokField = lombokAll || (lombokReq && hasModifier(mods, "final"));
          if (annotated || lombokField) collectInjectedTypes(member.childForFieldName("type"), injects);
        } else if (member.type === "method_declaration") {
          const annos = annotationNames(modifiersOf(member));
          const isSetter = [...annos].some((a) => INJECT_ANNOTATIONS.has(a));
          const isBeanMethod = annos.has("Bean");
          if (isSetter || isBeanMethod) {
            for (const p of member.childForFieldName("parameters")?.namedChildren ?? []) {
              if (p?.type === "formal_parameter") collectInjectedTypes(paramType(p), injects);
            }
          }
          if (isBeanMethod) {
            const ret = member.childForFieldName("type");
            if (ret?.type === "type_identifier") produces.push(ret.text);
          }
        }
      }
    }
    types.push({ file, name, supers, isBean, injects, produces });
  }
  return types;
}

/**
 * Compute the Spring DI edges for a repo's Java files and merge them into the graph's import maps.
 * Adds an edge (symbol "*") from each injecting bean file to every bean file that could satisfy an
 * injection: a concrete bean of the injected type, an implementation of an injected interface, or
 * the `@Configuration` that produces the type via a `@Bean` method. Mutates `imports`/`importSymbols`.
 */
export function applySpringEdges(
  root: string,
  javaRelFiles: string[],
  imports: Map<string, Set<string>>,
  importSymbols: Map<string, Map<string, Set<string>>>,
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

  // Repo-wide bean index: a simple type name → the bean files that satisfy an injection of it. A
  // concrete bean class contributes its own name; an @Bean factory contributes its produced types;
  // a bean contributes every interface/superclass it implements (so an interface injection resolves
  // to its implementations).
  const beanIndex = new Map<string, Set<string>>();
  const add = (typeName: string, file: string): void => {
    let set = beanIndex.get(typeName);
    if (!set) {
      set = new Set();
      beanIndex.set(typeName, set);
    }
    set.add(file);
  };
  for (const t of all) {
    if (!t.isBean) continue;
    add(t.name, t.file);
    for (const s of t.supers) add(s, t.file);
    for (const p of t.produces) add(p, t.file);
  }

  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    let deps = imports.get(from);
    if (!deps) {
      deps = new Set();
      imports.set(from, deps);
    }
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
  };

  for (const t of all) {
    if (!t.isBean) continue;
    for (const injected of t.injects) {
      for (const target of beanIndex.get(injected) ?? []) addEdge(t.file, target);
    }
  }
}

/** The repo-relative posix paths of every `.java` file in the graph's file set. */
export function javaFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".java"));
}
