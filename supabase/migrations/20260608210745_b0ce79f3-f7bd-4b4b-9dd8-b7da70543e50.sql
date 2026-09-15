-- 1) Limpeza: remove duplicatas ready do mesmo audio_hash, mantendo a mais antiga
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, audio_hash
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.call_audio_generations
  WHERE generation_status = 'ready'
    AND audio_hash IS NOT NULL
)
DELETE FROM public.call_audio_generations c
USING ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- 2) Índice único parcial: impede futuras duplicatas ready por (tenant, audio_hash)
CREATE UNIQUE INDEX IF NOT EXISTS call_audio_generations_unique_ready_hash
  ON public.call_audio_generations (tenant_id, audio_hash)
  WHERE generation_status = 'ready' AND audio_hash IS NOT NULL;