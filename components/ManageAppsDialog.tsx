"use client";

import { useActionState, useState } from "react";
import { addApplication, updateApplication, deleteApplication } from "@/app/actions/apps";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Button, TextLinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Tile } from "@/components/ui/Tile";
import styles from "@/app/(app)/storage/storage.module.css";

type App = {
  id: string;
  name: string;
  slug: string;
  platform: string;
  initials: string;
};

type Mode = "list" | "add" | "edit";

type AppFormState = { errors?: Record<string, string[]>; message?: string } | undefined;

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function AddForm({ onBack }: { onBack: () => void }) {
  const [state, formAction, pending] = useActionState(addApplication, undefined);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [initials, setInitials] = useState("");
  const errors = (state as AppFormState)?.errors;

  return (
    <form action={formAction}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
        <Field label="App name">
          <Input
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(slugify(e.target.value));
              setInitials(e.target.value.slice(0, 2).toUpperCase());
            }}
            placeholder="My App"
            required
          />
          {errors?.name && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.name[0]}</span>}
        </Field>
        <Field label="Slug" hint="URL-safe identifier — lowercase, numbers, hyphens">
          <Input
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-app"
            mono
            required
          />
          {errors?.slug && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.slug[0]}</span>}
        </Field>
        <Field label="Platform">
          <Input
            name="platform"
            defaultValue="Android, APK"
            placeholder="Android, APK"
            required
          />
          {errors?.platform && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.platform[0]}</span>}
        </Field>
        <Field label="Initials" hint="2–4 chars shown in tile">
          <Input
            name="initials"
            value={initials}
            onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="MA"
            style={{ width: 80 }}
            required
          />
          {errors?.initials && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.initials[0]}</span>}
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <TextLinkButton type="button" onClick={onBack}>Back</TextLinkButton>
        <Button type="submit" variant="primary" size="md" disabled={pending}>
          {pending ? "Creating…" : "Create app"}
        </Button>
      </div>
    </form>
  );
}

function EditForm({ app, onBack }: { app: App; onBack: () => void }) {
  const [state, formAction, pending] = useActionState(updateApplication, undefined);
  const [name, setName] = useState(app.name);
  const [slug, setSlug] = useState(app.slug);
  const [initials, setInitials] = useState(app.initials);
  const errors = (state as AppFormState)?.errors;

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={app.id} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
        <Field label="App name">
          <Input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My App"
            required
          />
          {errors?.name && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.name[0]}</span>}
        </Field>
        <Field label="Slug" hint="URL-safe identifier — lowercase, numbers, hyphens">
          <Input
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-app"
            mono
            required
          />
          {errors?.slug && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.slug[0]}</span>}
        </Field>
        <Field label="Platform">
          <Input
            name="platform"
            defaultValue={app.platform}
            placeholder="Android, APK"
            required
          />
          {errors?.platform && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.platform[0]}</span>}
        </Field>
        <Field label="Initials" hint="2–4 chars shown in tile">
          <Input
            name="initials"
            value={initials}
            onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="MA"
            style={{ width: 80 }}
            required
          />
          {errors?.initials && <span style={{ fontSize: 12, color: "var(--danger)" }}>{errors.initials[0]}</span>}
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <TextLinkButton type="button" onClick={onBack}>Back</TextLinkButton>
        <Button type="submit" variant="primary" size="md" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function ManageAppsDialog({ apps }: { apps: App[] }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [editTarget, setEditTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setMode("list");
    setEditTarget(null);
    setDeleting(null);
  }

  return (
    <>
      <Button type="button" variant="ghost" size="md" onClick={() => setOpen(true)}>
        Manage apps
      </Button>

      {open && (
        <div className={styles.scrim} onClick={close}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>

            {mode === "list" && (
              <>
                <h2 className={styles.dialogTitle}>Applications</h2>
                <p className={styles.dialogSub}>Add, edit or remove apps.</p>

                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                  {apps.length === 0 && (
                    <p style={{ fontSize: 13, color: "var(--muted)" }}>No applications yet.</p>
                  )}
                  {apps.map((app) => (
                    <div
                      key={app.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-sm)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <Tile size="sm">{app.initials}</Tile>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{app.name}</span>
                        <span
                          style={{
                            display: "block",
                            fontSize: 11,
                            color: "var(--muted)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {app.slug}
                        </span>
                      </span>

                      {deleting === app.id ? (
                        <DeleteAppConfirm appId={app.id} onCancel={() => setDeleting(null)} />
                      ) : (
                        <span style={{ display: "flex", gap: 6 }}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditTarget(app);
                              setMode("edit");
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            onClick={() => setDeleting(app.id)}
                          >
                            Delete
                          </Button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button type="button" variant="ghost" size="md" onClick={close}>
                    Close
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={() => setMode("add")}
                  >
                    Add app
                  </Button>
                </div>
              </>
            )}

            {mode === "add" && (
              <>
                <h2 className={styles.dialogTitle}>Add application</h2>
                <p className={styles.dialogSub}>Create a new app to upload builds to.</p>
                <AddForm onBack={() => setMode("list")} />
              </>
            )}

            {mode === "edit" && editTarget && (
              <>
                <h2 className={styles.dialogTitle}>Edit application</h2>
                <p className={styles.dialogSub}>Update the details for {editTarget.name}.</p>
                <EditForm app={editTarget} onBack={() => setMode("list")} />
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function DeleteAppConfirm({ appId, onCancel }: { appId: string; onCancel: () => void }) {
  const [state, action] = useActionState(deleteApplication, undefined);

  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--danger)" }}>Delete?</span>
        <form action={action}>
          <input type="hidden" name="id" value={appId} />
          <SubmitButton variant="danger" size="sm" pendingLabel="Deleting…">Yes</SubmitButton>
        </form>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          No
        </Button>
      </span>
      {state?.message && (
        <span role="alert" style={{ fontSize: 12, color: "var(--danger)", maxWidth: 260, textAlign: "right" }}>
          {state.message}
        </span>
      )}
    </span>
  );
}
