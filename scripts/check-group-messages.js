// Read-only: inspect group messages to verify sender-name prefixes.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const msgs = await prisma.message.findMany({
      where: {
        conversation: { contact: { phone: { endsWith: '@g.us' } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        body: true,
        direction: true,
        contentType: true,
        createdAt: true,
        conversation: {
          select: { contact: { select: { name: true, phone: true } } },
        },
      },
    });
    for (const m of msgs) {
      console.log(
        `[${m.conversation.contact.name}] ${m.direction} ${m.contentType}: ${m.body.slice(0, 80)}`,
      );
    }
    console.log('group msg shown:', msgs.length);
    console.log('total messages:', await prisma.message.count());
    console.log('total conversations:', await prisma.conversation.count());
  } finally {
    await prisma.$disconnect();
  }
}

main();
