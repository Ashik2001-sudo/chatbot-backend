// Read-only: print channel statuses.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const channels = await prisma.channelConnection.findMany({
      select: { id: true, name: true, type: true, status: true },
    });
    console.table(channels);
  } finally {
    await prisma.$disconnect();
  }
}

main();
