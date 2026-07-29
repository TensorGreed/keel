import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, transitiveDependents, type FileGraph } from "../src/graph/dependencies.js";
import { initGraphScanners } from "../src/graph/scanners.js";

// Spring DI edges: the runtime wiring imports can't express. The fixture puts the injected
// implementations in a different package from the injector, importing only the interface — so any
// injector→impl edge here is one imports alone would miss. Deterministic; no build tool needed.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const M = "src/main/java/com/example";

describe("spring DI edges", () => {
  let g: FileGraph;
  beforeAll(async () => {
    await initGraphScanners();
    g = buildFileGraph(path.join(fixtures, "java-spring"));
  });

  it("wires an injected interface to every implementation (invisible to imports)", () => {
    // OrderService injects the PaymentGateway interface via its constructor; it imports the
    // interface, NOT the impls — yet Spring wires both StripeGateway and PaypalGateway.
    const deps = reportFor(g, `${M}/app/OrderService.java`).dependencies;
    expect(deps).toContain(`${M}/impl/StripeGateway.java`);
    expect(deps).toContain(`${M}/impl/PaypalGateway.java`);
    // Proof it isn't just an import edge: OrderService never imports the impls.
    expect(deps).toContain(`${M}/api/PaymentGateway.java`); // it DOES import the interface
  });

  it("wires an injected @Bean-produced type to the @Configuration that produces it", () => {
    // OrderService injects Ledger; Ledger is produced by AppConfig's @Bean method, so the runtime
    // dependency is on AppConfig — which OrderService does not import.
    expect(reportFor(g, `${M}/app/OrderService.java`).dependencies).toContain(`${M}/config/AppConfig.java`);
    expect(reportFor(g, `${M}/config/AppConfig.java`).dependents).toContain(`${M}/app/OrderService.java`);
  });

  it("wires an @Autowired field to its component", () => {
    expect(reportFor(g, `${M}/app/OrderService.java`).dependencies).toContain(`${M}/audit/AuditLog.java`);
  });

  it("puts an implementation in the injector's blast radius (so a change selects its test)", () => {
    // Change StripeGateway → OrderService (DI) → OrderServiceTest (same-package adjacency). This is
    // the whole point: a test of the service is selected when a wired-in impl changes.
    const radius = transitiveDependents(g, `${M}/impl/StripeGateway.java`);
    expect(radius).toContain(`${M}/app/OrderService.java`);
    expect(radius).toContain("src/test/java/com/example/app/OrderServiceTest.java");
  });

  const implEdges = (cls: string): string[] =>
    reportFor(g, `${M}/app/${cls}`).dependencies.filter((d) => d.startsWith(`${M}/impl/`));

  it("narrows an interface injection to the impl named by @Qualifier (explicit bean name)", () => {
    // QualifiedService injects @Qualifier("fast"); FastGateway is @Component("fast").
    expect(implEdges("QualifiedService.java")).toEqual([`${M}/impl/FastGateway.java`]);
  });

  it("narrows via a bean's default (decapitalized class) name", () => {
    // DefaultNameService injects @Qualifier("paypalGateway") — the default name of PaypalGateway.
    expect(implEdges("DefaultNameService.java")).toEqual([`${M}/impl/PaypalGateway.java`]);
  });

  it("keeps all candidates when a @Qualifier matches no known bean (stays conservative)", () => {
    // "ghostBean" names nothing in the repo, so we don't drop the edge — all impls remain.
    expect(implEdges("LooseService.java").sort()).toEqual([
      `${M}/impl/FastGateway.java`, `${M}/impl/PaypalGateway.java`, `${M}/impl/StripeGateway.java`,
    ]);
  });

  it("edges to every impl when the injection is unqualified", () => {
    expect(implEdges("OrderService.java").sort()).toEqual([
      `${M}/impl/FastGateway.java`, `${M}/impl/PaypalGateway.java`, `${M}/impl/StripeGateway.java`,
    ]);
  });

  it("does not invent DI edges from a bean it does not inject", () => {
    // AuditLog injects nothing, so it depends on no bean (its only edges would be real imports).
    expect(reportFor(g, `${M}/audit/AuditLog.java`).dependencies).toEqual([]);
  });

  it("draws no DI edges in a repo with no Spring beans", () => {
    // The plain Maven fixture has no stereotypes — the enrichment runs but adds nothing.
    const plain = buildFileGraph(path.join(fixtures, "java-maven"));
    expect(reportFor(plain, `${M}/app/Service.java`).dependencies).not.toContain(`${M}/util/Helper.java.di`);
    // Service's deps are exactly its imports + same-package adjacency, unchanged by the DI pass.
    expect(reportFor(plain, `${M}/util/Helper.java`).dependencies).toEqual([`${M}/util/Constants.java`]);
  });
});

describe("spring DI — candidates don't cross module boundaries", () => {
  // Two modules each declare the SAME types (a `Gateway` interface + a `StripeGateway` @Component
  // impl). An injected interface must resolve only to its own module's impl, not the sibling's.
  it("scopes an injected interface's implementations to the injector's module", () => {
    const g = buildFileGraph(path.join(fixtures, "java-spring-multi"));
    const checkoutA = "moduleA/src/main/java/com/example/svc/Checkout.java";
    const implA = "moduleA/src/main/java/com/example/impl/StripeGateway.java";
    const implB = "moduleB/src/main/java/com/example/impl/StripeGateway.java";
    const depsA = reportFor(g, checkoutA).dependencies;
    expect(depsA).toContain(implA); // same-module DI candidate — kept
    expect(depsA).not.toContain(implB); // the foreign module's identically-named impl — not a candidate
    // Symmetric: moduleB's injector reaches only moduleB's impl.
    expect(reportFor(g, "moduleB/src/main/java/com/example/svc/Checkout.java").dependencies).not.toContain(implA);
  });
});
