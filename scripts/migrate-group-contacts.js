// One-off: older group contacts were saved with a bare group id (no @g.us)
// and the last sender's name. Fix the JID so replies route to the group, and
// clear the name so the next message fills in the real group subject.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const contacts = await prisma.contact.findMany();
    for (const c of contacts) {
      if (!c.phone || c.phone.includes('@') || !/^120363\d+$/.test(c.phone)) continue;
      const groupJid = `${c.phone}@g.us`;
      await prisma.contact.update({
        where: { id: c.id },
        data: {
          phone: groupJid,
          name: null,
          externalIds: { whatsapp: groupJid },
        },
      });
      console.log(`Migrated group contact ${c.id}: ${c.phone} -> ${groupJid}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
