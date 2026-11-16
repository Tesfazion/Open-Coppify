import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be configured before using the database.");
}

const databaseProtocol = new URL(connectionString).protocol;
if (databaseProtocol !== "postgres:" && databaseProtocol !== "postgresql:") {
  throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
}

const poolMax = Number(process.env.DATABASE_POOL_MAX ?? "10");
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 50) {
  throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 50.");
}

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: poolMax }),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
