CREATE TABLE "DirectorCharacterStateAsset" (
  "id" TEXT NOT NULL,
  "productionId" TEXT NOT NULL,
  "stateId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "assetName" TEXT NOT NULL,
  "stateName" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "imageModelRoute" TEXT NOT NULL,
  "soulIdRequired" BOOLEAN NOT NULL DEFAULT false,
  "selectedImageVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DirectorCharacterStateAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorStateImageTask" (
  "id" TEXT NOT NULL,
  "stateAssetId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'queued',
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "referenceMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "progress" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DirectorStateImageTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorStateImageVersion" (
  "id" TEXT NOT NULL,
  "stateAssetId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DirectorStateImageVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DirectorCharacterStateAsset_selectedImageVersionId_key" ON "DirectorCharacterStateAsset"("selectedImageVersionId");
CREATE UNIQUE INDEX "DirectorCharacterStateAsset_productionId_stateId_key" ON "DirectorCharacterStateAsset"("productionId", "stateId");
CREATE INDEX "DirectorCharacterStateAsset_productionId_assetId_idx" ON "DirectorCharacterStateAsset"("productionId", "assetId");
CREATE INDEX "DirectorStateImageTask_stateAssetId_status_idx" ON "DirectorStateImageTask"("stateAssetId", "status");
CREATE INDEX "DirectorStateImageTask_createdById_idx" ON "DirectorStateImageTask"("createdById");
CREATE UNIQUE INDEX "DirectorStateImageVersion_taskId_key" ON "DirectorStateImageVersion"("taskId");
CREATE UNIQUE INDEX "DirectorStateImageVersion_stateAssetId_version_key" ON "DirectorStateImageVersion"("stateAssetId", "version");
CREATE INDEX "DirectorStateImageVersion_mediaId_idx" ON "DirectorStateImageVersion"("mediaId");

ALTER TABLE "DirectorCharacterStateAsset" ADD CONSTRAINT "DirectorCharacterStateAsset_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "DirectorProduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStateImageTask" ADD CONSTRAINT "DirectorStateImageTask_stateAssetId_fkey" FOREIGN KEY ("stateAssetId") REFERENCES "DirectorCharacterStateAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStateImageTask" ADD CONSTRAINT "DirectorStateImageTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStateImageVersion" ADD CONSTRAINT "DirectorStateImageVersion_stateAssetId_fkey" FOREIGN KEY ("stateAssetId") REFERENCES "DirectorCharacterStateAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStateImageVersion" ADD CONSTRAINT "DirectorStateImageVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DirectorStateImageTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStateImageVersion" ADD CONSTRAINT "DirectorStateImageVersion_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DirectorCharacterStateAsset" ADD CONSTRAINT "DirectorCharacterStateAsset_selectedImageVersionId_fkey" FOREIGN KEY ("selectedImageVersionId") REFERENCES "DirectorStateImageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
