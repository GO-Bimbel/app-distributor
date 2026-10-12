"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  createSession,
  deleteSession,
  createResetSession,
  getResetUserId,
  deleteResetSession,
} from "@/lib/session";
import {
  SignupFormSchema,
  LoginFormSchema,
  ResetPasswordFormSchema,
  type FormState,
} from "@/app/lib/definitions";

export async function signup(_state: FormState, formData: FormData): Promise<FormState> {
  const validated = SignupFormSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const { name, email, password } = validated.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { message: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: "PUBLISHER" },
  });

  await createSession(user.id, user.role);
  redirect("/");
}

export async function login(_state: FormState, formData: FormData): Promise<FormState> {
  const validated = LoginFormSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const { email, password } = validated.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { message: "Invalid email or password." };
  }

  // Password was reset (passwordHash set to null): the email itself is the
  // one-time password, after which the user must choose a new one.
  if (user.passwordHash === null) {
    if (password.trim().toLowerCase() !== user.email.toLowerCase()) {
      return { message: "Invalid email or password." };
    }
    await createResetSession(user.id);
    redirect("/reset-password");
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    return { message: "Invalid email or password." };
  }

  await createSession(user.id, user.role);
  redirect("/");
}

export async function resetPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const userId = await getResetUserId();
  if (!userId) {
    redirect("/login");
  }

  const validated = ResetPasswordFormSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const passwordHash = await bcrypt.hash(validated.data.password, 10);
  // Only succeeds while the password is still unset, so a leftover reset
  // cookie can't overwrite a password the user has already chosen.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, passwordHash: null },
    data: { passwordHash },
  });
  await deleteResetSession();
  if (count === 0) {
    redirect("/login");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await createSession(user.id, user.role);
  redirect("/");
}

export async function logout() {
  await deleteSession();
  redirect("/login");
}
