// One-off: remove duplicate Baileys channel rows created by reconnects
// (keeping the connected/newest one), then remove orphaned contacts.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const baileys = await prisma.channelConnection.findMany({
      where: { type: 'WHATSAPP_BAILEYS' },
      orderBy: { createdAt: 'desc' },
    });
    const keeper =
      baileys.find((c) => c.status === 'connected') ?? baileys[0];
    const toDelete = baileys.filter((c) => c.id !== keeper?.id);
    for (const c of toDelete) {
      await prisma.channelConnection.delete({ where: { id: c.id } });
      console.log(`Deleted duplicate channel ${c.id} (${c.status})`);
    }
    if (keeper) console.log(`Kept channel ${keeper.id} (${keeper.status})`);

    const orphans = await prisma.contact.deleteMany({
      where: { conversations: { none: {} } },
    });
    console.log(`Deleted ${orphans.count} contacts without conversations`);

    console.log('channels left:', await prisma.channelConnection.count());
    console.log('contacts left:', await prisma.contact.count());
    console.log('conversations left:', await prisma.conversation.count());
    console.log('messages left:', await prisma.message.count());
  } finally {
    await prisma.$disconnect();
  }
}

main();
