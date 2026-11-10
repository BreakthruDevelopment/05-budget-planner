import { demoSeedConfig } from "../src/lib/demo-seed-config";
// Refuse production BEFORE loading the database or auth modules.
const config = demoSeedConfig();
const { db, schema } = await import("../src/lib/db");
const { eq } = await import("drizzle-orm");
const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
const { toRole } = await import("../src/lib/auth/rbac");
const [admin] = await db().select().from(schema.user).where(eq(schema.user.email, process.env.SEED_ADMIN_EMAIL ?? ""));
if (!admin || toRole(admin.role) !== "admin") throw new Error("Set SEED_ADMIN_EMAIL to an existing admin (db:seed creates one).");
await loadDemoWorkspace({ id: admin.id, role: "admin" }, { password: config.password });
console.log("Loaded three demo users, demo bank, budgets and prior-month transactions.");
process.exit(0);
