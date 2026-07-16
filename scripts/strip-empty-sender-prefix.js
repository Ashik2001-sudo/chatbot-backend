// One-off: earlier group history imports prefixed bodies with ": " when the
// sender name couldn't be resolved. Strip that orphan prefix.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const msgs = await prisma.message.findMany({
      where: { body: { startsWith: ': ' } },
      select: { id: true, body: true },
    });
    for (const m of msgs) {
      await prisma.message.update({
        where: { id: m.id },
        data: { body: m.body.slice(2) },
      });
    }
    console.log(`Cleaned ${msgs.length} message(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
