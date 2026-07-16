// One-off: remove abandoned WhatsApp QR attempts that never finished pairing.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await prisma.channelConnection.deleteMany({
      where: { type: 'WHATSAPP_BAILEYS', status: 'pending_qr' },
    });
    console.log(`Deleted ${result.count} stale pending_qr channel(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
