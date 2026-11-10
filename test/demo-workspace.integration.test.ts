import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
const url = process.env.TEST_DATABASE_URL;
const actor = { id: "demo-it-admin", role: "admin" as const };
describe.skipIf(!url)("demo workspace (Postgres)", () => {
  let sql: postgres.Sql;
  let load: typeof import("@/lib/demo-workspace").loadDemoWorkspace;
  beforeAll(async () => {
    process.env.DATABASE_URL = url; process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where email like '%@demo.breakthru.test' or id=${actor.id}`;
    await sql`insert into "user" (id,name,email,role) values (${actor.id},'Admin','demo-it-admin@test.local','admin')`;
    load = (await import("@/lib/demo-workspace")).loadDemoWorkspace;
  });
  afterAll(async () => { await sql`delete from "user" where email like '%@demo.breakthru.test' or id=${actor.id}`; await sql.end(); });
  it("rejects non-admins and refuses to replace an unrelated account claiming a demo address", async () => {
    await expect(load({ ...actor, role: "user" })).rejects.toMatchObject({ status: 403 });
    await sql`insert into "user" (id,name,email) values ('demo-collision','Unrelated','alex@demo.breakthru.test')`;
    await expect(load(actor)).rejects.toMatchObject({ status: 409 });
    expect((await sql`select name from "user" where id='demo-collision'`)[0].name).toBe("Unrelated");
    expect((await sql`select count(*)::int n from "user" where email like '%@demo.breakthru.test'`)[0].n).toBe(1);
    await sql`delete from "user" where id='demo-collision'`;
  });
  it("loads three users with demo accounts, budgets and prior-month rows; reload is safe and preserves credentials", async () => {
    const result = await load(actor, { password: "local-demo-password" });
    expect(result.users).toHaveLength(3);
    const ids = result.users.map(u => u.id);
    expect((await sql`select count(*)::int n from bank_item where owner_id in ${sql(ids)}`)[0].n).toBe(3);
    expect((await sql`select count(*)::int n from txn where owner_id in ${sql(ids)}`)[0].n).toBe(447);
    expect((await sql`select count(*)::int n from budget where owner_id in ${sql(ids)}`)[0].n).toBe(6);
    expect((await sql`select count(*)::int n from bank_item_secret where owner_id in ${sql(ids)}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int n from txn where owner_id in ${sql(ids)} and date < date_trunc('month',now())`)[0].n).toBeGreaterThan(0);
    const before = await sql`select user_id,password from account where user_id in ${sql(ids)} order by user_id`;
    const again = await load(actor);
    expect(again.users.map(u => u.id)).toEqual(ids);
    expect(await sql`select user_id,password from account where user_id in ${sql(ids)} order by user_id`).toEqual(before);
    expect((await sql`select count(*)::int n from txn where owner_id in ${sql(ids)}`)[0].n).toBe(447);
  });
  it("public auth cannot register a reserved identity or forge the marker", async () => {
    const { auth } = await import("@/lib/auth");
    const { MARKER } = await import("@/lib/demo-identity");
    for (const body of [{ email: "new@demo.breakthru.test", name: "Spoof", password: "demo-spoof-password" }, { email: "spoof-marker@test.local", name: "Spoof", password: "demo-spoof-password", image: MARKER }]) {
      const res = await auth().handler(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
    }
  });
});
