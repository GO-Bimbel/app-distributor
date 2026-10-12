"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resetPassword } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Logo } from "@/components/ui/Misc";
import styles from "../auth.module.css";

export function ResetPasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(resetPassword, undefined);

  return (
    <div className={styles.page}>
      <div className={styles.panel} style={{ gridTemplateColumns: "1fr" }}>
        <div className={styles.formSide} style={{ maxWidth: 440, margin: "0 auto" }}>
          <Logo />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 className={styles.title}>Set a new password</h1>
            <p className={styles.subtitle}>
              Your password was reset. Choose a new one for {email} to finish
              signing in.
            </p>
          </div>
          <form action={action} className={styles.form}>
            <input type="hidden" name="username" value={email} autoComplete="username" />
            <Field label="New password" hint="At least 8 characters, with a letter and a number.">
              <Input
                name="password"
                type="password"
                required
                autoComplete="new-password"
              />
            </Field>
            {state?.errors?.password && (
              <p className={styles.fieldErrors}>{state.errors.password[0]}</p>
            )}
            <Field label="Confirm new password">
              <Input
                name="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
              />
            </Field>
            {state?.errors?.confirmPassword && (
              <p className={styles.fieldErrors}>{state.errors.confirmPassword[0]}</p>
            )}
            {state?.message && <p className={styles.formError}>{state.message}</p>}
            <div className={styles.actions} style={{ marginTop: 8 }}>
              <Button type="submit" variant="primary" size="lg" block disabled={pending}>
                {pending ? "Saving…" : "Save and sign in"}
              </Button>
            </div>
          </form>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>
            Not you? <Link href="/login">Back to sign in</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
