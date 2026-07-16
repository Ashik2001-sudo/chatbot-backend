// One-off: merge duplicate conversations that share the same contact and
// channel (created by a race that is now fixed). Keeps the oldest row and
// moves messages over.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const conversations = await prisma.conversation.findMany({
      orderBy: { createdAt: 'asc' },
    });
    const byKey = new Map();
    for (const conv of conversations) {
      const key = `${conv.tenantId}:${conv.contactId}:${conv.channelConnId}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(conv);
    }

    for (const [key, group] of byKey) {
      if (group.length < 2) continue;
      const [keeper, ...dupes] = group;
      for (const dupe of dupes) {
        await prisma.message.updateMany({
          where: { conversationId: dupe.id },
          data: { conversationId: keeper.id },
        });
        await prisma.conversation.delete({ where: { id: dupe.id } });
      }
      const latest = await prisma.message.findFirst({
        where: { conversationId: keeper.id },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) {
        await prisma.conversation.update({
          where: { id: keeper.id },
          data: { lastMessageAt: latest.createdAt },
        });
      }
      console.log(`Merged ${dupes.length} duplicate(s) into ${keeper.id} (${key})`);
    }

    console.log('conversations left:', await prisma.conversation.count());
    console.log('messages left:', await prisma.message.count());
  } finally {
    await prisma.$disconnect();
  }
}

main();
