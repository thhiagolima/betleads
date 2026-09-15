
-- Remove a SELECT policy ampla. Bucket público continua servindo arquivos por URL,
-- mas listagem anônima passa a ser bloqueada.
DROP POLICY IF EXISTS "whatsapp-media public read" ON storage.objects;
