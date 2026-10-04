import { MongoClient } from "mongodb";
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
export async function manageMongo(command) {
  if (
    ![
      "list-users",
      "add-user",
      "reset-password",
      "remove-user",
      "check",
    ].includes(command)
  )
    throw new Error(
      "MongoDB commands: check, list-users, add-user, reset-password, remove-user. Use Atlas backups or mongodump for database + GridFS backups.",
    );
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "formiq");
    if (command === "check") {
      await db.command({ ping: 1 });
      console.log("MongoDB connection successful.");
      return;
    }
    if (command === "list-users") {
      for await (const user of db
        .collection("users")
        .find({}, { projection: { name: 1, email: 1 } }))
        console.log(`${user.name} <${user.email}>`);
      return;
    }
    if ((await db.collection("users").countDocuments({}, { limit: 1 })) === 0)
      throw new Error(
        "Start the app once to create the initial administrator.",
      );
    const email = (process.env.FORMIQ_USER_EMAIL || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)
      throw new Error("Set a valid FORMIQ_USER_EMAIL.");
    const password = process.env.FORMIQ_USER_PASSWORD || "",
      name = (process.env.FORMIQ_USER_NAME || "Team member").trim();
    if (
      command !== "remove-user" &&
      (password.length < 12 ||
        password.length > 200 ||
        !name ||
        name.length > 100)
    )
      throw new Error(
        "Set FORMIQ_USER_PASSWORD (12–200 characters) and FORMIQ_USER_NAME (1–100 characters).",
      );
    const salt = randomBytes(16).toString("hex"),
      hash =
        command === "remove-user"
          ? ""
          : scryptSync(password, salt, 64).toString("hex");
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        // Serialize operator changes, including concurrent attempts to remove the last user.
        await db
          .collection("settings")
          .updateOne(
            { _id: "account-management" },
            { $inc: { version: 1 } },
            { upsert: true, session },
          );
        const existing = await db
          .collection("users")
          .findOne({ email }, { session });
        const accountId = existing?._id ?? randomUUID();
        if (command === "add-user") {
          if (existing)
            throw new Error("Account already exists; use reset-password.");
          await db
            .collection("users")
            .insertOne(
              { _id: accountId, name, email, salt, hash },
              { session },
            );
        } else {
          if (!existing) throw new Error("Account does not exist.");
          if (
            command === "remove-user" &&
            (await db.collection("users").countDocuments({}, { session })) <= 1
          )
            throw new Error("Cannot remove the last account.");
          if (command === "reset-password")
            await db
              .collection("users")
              .updateOne(
                { _id: existing._id },
                { $set: { salt, hash } },
                { session },
              );
          else
            await db
              .collection("users")
              .deleteOne({ _id: existing._id }, { session });
          await db
            .collection("sessions")
            .deleteMany({ userId: existing._id }, { session });
        }
        const id = randomUUID();
        await db.collection("records").insertOne(
          {
            _id: id,
            kind: "audit",
            ownerId: String(accountId),
            projectId: "",
            createdAt: new Date(),
            data: {
              id,
              projectId: "",
              actor: "Workspace administrator (CLI)",
              action: command,
              detail: email,
              createdAt: new Date().toISOString(),
            },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    console.log(`Completed ${command}.`);
  } catch (error) {
    // Never print MongoDB connection strings, server diagnostics or credentials.
    if (
      error?.name?.startsWith("Mongo") ||
      error?.code === "ECONNREFUSED" ||
      error?.code === "ENOTFOUND"
    )
      throw new Error(
        "MongoDB operation failed. Check Atlas access, credentials, unique account email and transaction support.",
      );
    throw error;
  } finally {
    await client.close();
  }
}
