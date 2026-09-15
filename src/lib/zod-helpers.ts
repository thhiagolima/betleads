import { z } from "zod";

// UUID permissivo: aceita qualquer hex 8-4-4-4-12 (formato que o Postgres aceita
// no tipo uuid). O `z.string().uuid()` do Zod v4 é RFC 9562 estrito e rejeita
// UUIDs gerados por clonagens via md5/encode (version/variant nibbles fora do
// padrão), mesmo sendo IDs válidos no banco.
export const dbUuid = () =>
  z
    .string()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "UUID inválido",
    );