// Read-only: inspect recent contacts and conversation counts.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        name: true,
        phone: true,
        createdAt: true,
        _count: { select: { conversations: true } },
      },
    });
    for (const c of contacts) {
      console.log(
        `${c.createdAt.toISOString()} | phone=${c.phone} | name=${c.name} | convs=${c._count.conversations}`,
      );
    }
    console.log('total contacts:', await prisma.contact.count());
    console.log('total conversations:', await prisma.conversation.count());
    console.log('total messages:', await prisma.message.count());
  } finally {
    await prisma.$disconnect();
  }
}

main();
