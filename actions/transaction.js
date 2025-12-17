"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
  try {
    const { db } = await import("@/lib/prisma");

    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const req = await request();

    const decision = await aj.protect(req, {
      userId,
      requested: 1,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const account = await db.account.findUnique({
      where: { id: data.accountId, userId: user.id },
    });
    if (!account) throw new Error("Account not found");

    const balanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const transaction = await db.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          ...data,
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(
                  data.date,
                  data.recurringInterval
                )
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: balanceChange,
          },
        },
      });

      return created;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get Single Transaction
export async function getTransaction(id) {
  const { db } = await import("@/lib/prisma");

  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: { id, userId: user.id },
  });
  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

// Update Transaction
export async function updateTransaction(id, data) {
  try {
    const { db } = await import("@/lib/prisma");

    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const original = await db.transaction.findUnique({
      where: { id, userId: user.id },
      include: { account: true },
    });
    if (!original) throw new Error("Transaction not found");

    const oldChange =
      original.type === "EXPENSE"
        ? -original.amount.toNumber()
        : original.amount.toNumber();

    const newChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netChange = newChange - oldChange;

    const updated = await db.$transaction(async (tx) => {
      const txUpdated = await tx.transaction.update({
        where: { id, userId: user.id },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(
                  data.date,
                  data.recurringInterval
                )
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netChange,
          },
        },
      });

      return txUpdated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(updated) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get User Transactions
export async function getUserTransactions(query = {}) {
  try {
    const { db } = await import("@/lib/prisma");

    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions.map(serializeAmount) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Scan Receipt
export async function scanReceipt(file) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    });

    const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");

    const prompt = `
      Analyze this receipt image and extract the following information in JSON:
      {
        "amount": number,
        "date": "ISO string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }
      If not a receipt, return {}
    `;

    const result = await model.generateContent([
      {
        inlineData: {
          data: buffer,
          mimeType: file.type,
        },
      },
      prompt,
    ]);

    const text = result.response.text().replace(/```(?:json)?/g, "").trim();
    const data = JSON.parse(text);

    return {
      amount: parseFloat(data.amount),
      date: new Date(data.date),
      description: data.description,
      category: data.category,
      merchantName: data.merchantName,
    };
  } catch {
    throw new Error("Failed to scan receipt");
  }
}

// Helper
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  if (interval === "DAILY") date.setDate(date.getDate() + 1);
  if (interval === "WEEKLY") date.setDate(date.getDate() + 7);
  if (interval === "MONTHLY") date.setMonth(date.getMonth() + 1);
  if (interval === "YEARLY") date.setFullYear(date.getFullYear() + 1);

  return date;
}
