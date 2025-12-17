import { db } from "../lib/prisma.js";
import { subDays } from "date-fns";

async function main() {
  const ACCOUNT_ID = "account-id";
  const USER_ID = "user-id";

  const transactions = [];
  let totalBalance = 0;

  for (let i = 90; i >= 0; i--) {
    const date = subDays(new Date(), i);

    const type = Math.random() < 0.4 ? "INCOME" : "EXPENSE";
    const amount = Math.random() * 500;

    transactions.push({
      type,
      amount,
      description: "Seed transaction",
      date,
      status: "COMPLETED",
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      createdAt: date,
      updatedAt: date,
    });

    totalBalance += type === "INCOME" ? amount : -amount;
  }

  await db.transaction.createMany({ data: transactions });
  await db.account.update({
    where: { id: ACCOUNT_ID },
    data: { balance: totalBalance },
  });
}

main()
  .then(() => {
    console.log("Seeding complete");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
