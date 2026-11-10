import { DemoButton } from "./demo-button";
import { adminCounts } from "@/lib/budget";
import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const actor = await requireRoleOrRedirect("admin");
  const counts = await adminCounts(actor);
  const users = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(100);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => (u.role === "admin" ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.toISOString().slice(0, 10),
    },
  ];

  return (
    <>
      <PageIntro section="Admin" title="Users" description="Everyone who has signed up, newest first." />
      <Panel title="Demo workspace"><DemoButton /></Panel>
      <StatGrid>
        <StatTile value={counts.users} label="Users" tone="accent" />
        <StatTile value={counts.items.demo + counts.items.plaid} label="Linked items" />
        <StatTile value={counts.transactions} label="Transactions" />
        <StatTile value={`${counts.aiCalls} / ${counts.aiDailyCap}`} label="AI calls today / cap" />
        <StatTile value={users.filter((u) => u.role === "admin").length} label="Admins" />
      </StatGrid>
      <Panel title="All users" count={users.length}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}
