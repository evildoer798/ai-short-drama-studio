CREATE TYPE "DirectorStage" AS ENUM ('acting', 'lira', 'cinedance', 'review', 'completed');
CREATE TYPE "DirectorProductionStatus" AS ENUM ('active', 'completed', 'archived');
CREATE TYPE "DirectorStageStatus" AS ENUM ('draft', 'generating', 'ready', 'confirmed', 'failed');
CREATE TYPE "DirectorVideoDecision" AS ENUM ('undecided', 'selected', 'rejected');
CREATE TYPE "DirectorFrameType" AS ENUM ('first', 'end');

CREATE TABLE "DirectorProduction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceEpisodeId" TEXT,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currentStage" "DirectorStage" NOT NULL DEFAULT 'acting',
    "status" "DirectorProductionStatus" NOT NULL DEFAULT 'active',
    "sourceSnapshot" JSONB NOT NULL,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorProduction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorStageVersion" (
    "id" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "stage" "DirectorStage" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DirectorStageStatus" NOT NULL DEFAULT 'draft',
    "inputSnapshot" JSONB NOT NULL,
    "output" JSONB,
    "feedback" TEXT,
    "error" TEXT,
    "skillName" TEXT NOT NULL,
    "skillVersion" TEXT NOT NULL,
    "promptSnapshot" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorStageVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorShot" (
    "id" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "scriptExcerpt" TEXT NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 8,
    "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
    "performance" JSONB NOT NULL,
    "visualPlan" JSONB NOT NULL,
    "motionPlan" JSONB NOT NULL,
    "continuityIn" JSONB NOT NULL,
    "continuityOut" JSONB NOT NULL,
    "generationPrompt" TEXT NOT NULL,
    "selectedVideoVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorShot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorVideoTask" (
    "id" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible-video',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "generateAudio" BOOLEAN NOT NULL DEFAULT true,
    "referenceMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerJobId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "DirectorVideoTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorVideoVersion" (
    "id" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "decision" "DirectorVideoDecision" NOT NULL DEFAULT 'undecided',
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorVideoVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorKeyframe" (
    "id" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "shotKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "frameType" "DirectorFrameType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
    "selectedImageVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorKeyframe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorImageTask" (
    "id" TEXT NOT NULL,
    "keyframeId" TEXT NOT NULL,
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
    CONSTRAINT "DirectorImageTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DirectorImageVersion" (
    "id" TEXT NOT NULL,
    "keyframeId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectorImageVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DirectorProduction_projectId_updatedAt_idx" ON "DirectorProduction"("projectId", "updatedAt");
CREATE INDEX "DirectorProduction_sourceEpisodeId_idx" ON "DirectorProduction"("sourceEpisodeId");
CREATE INDEX "DirectorProduction_createdById_idx" ON "DirectorProduction"("createdById");
CREATE INDEX "DirectorStageVersion_productionId_stage_status_idx" ON "DirectorStageVersion"("productionId", "stage", "status");
CREATE INDEX "DirectorStageVersion_confirmedById_idx" ON "DirectorStageVersion"("confirmedById");
CREATE UNIQUE INDEX "DirectorStageVersion_productionId_stage_version_key" ON "DirectorStageVersion"("productionId", "stage", "version");
CREATE UNIQUE INDEX "DirectorShot_selectedVideoVersionId_key" ON "DirectorShot"("selectedVideoVersionId");
CREATE INDEX "DirectorShot_productionId_updatedAt_idx" ON "DirectorShot"("productionId", "updatedAt");
CREATE UNIQUE INDEX "DirectorShot_productionId_order_key" ON "DirectorShot"("productionId", "order");
CREATE INDEX "DirectorVideoTask_shotId_status_idx" ON "DirectorVideoTask"("shotId", "status");
CREATE INDEX "DirectorVideoTask_createdById_idx" ON "DirectorVideoTask"("createdById");
CREATE UNIQUE INDEX "DirectorVideoVersion_taskId_key" ON "DirectorVideoVersion"("taskId");
CREATE INDEX "DirectorVideoVersion_mediaId_idx" ON "DirectorVideoVersion"("mediaId");
CREATE INDEX "DirectorVideoVersion_shotId_decision_idx" ON "DirectorVideoVersion"("shotId", "decision");
CREATE UNIQUE INDEX "DirectorVideoVersion_shotId_version_key" ON "DirectorVideoVersion"("shotId", "version");
CREATE UNIQUE INDEX "DirectorKeyframe_selectedImageVersionId_key" ON "DirectorKeyframe"("selectedImageVersionId");
CREATE INDEX "DirectorKeyframe_productionId_shotKey_idx" ON "DirectorKeyframe"("productionId", "shotKey");
CREATE UNIQUE INDEX "DirectorKeyframe_productionId_shotKey_frameType_key" ON "DirectorKeyframe"("productionId", "shotKey", "frameType");
CREATE INDEX "DirectorImageTask_keyframeId_status_idx" ON "DirectorImageTask"("keyframeId", "status");
CREATE INDEX "DirectorImageTask_createdById_idx" ON "DirectorImageTask"("createdById");
CREATE UNIQUE INDEX "DirectorImageVersion_taskId_key" ON "DirectorImageVersion"("taskId");
CREATE INDEX "DirectorImageVersion_mediaId_idx" ON "DirectorImageVersion"("mediaId");
CREATE UNIQUE INDEX "DirectorImageVersion_keyframeId_version_key" ON "DirectorImageVersion"("keyframeId", "version");

ALTER TABLE "DirectorProduction" ADD CONSTRAINT "DirectorProduction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorProduction" ADD CONSTRAINT "DirectorProduction_sourceEpisodeId_fkey" FOREIGN KEY ("sourceEpisodeId") REFERENCES "ScriptEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DirectorProduction" ADD CONSTRAINT "DirectorProduction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DirectorStageVersion" ADD CONSTRAINT "DirectorStageVersion_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "DirectorProduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorStageVersion" ADD CONSTRAINT "DirectorStageVersion_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DirectorShot" ADD CONSTRAINT "DirectorShot_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "DirectorProduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorShot" ADD CONSTRAINT "DirectorShot_selectedVideoVersionId_fkey" FOREIGN KEY ("selectedVideoVersionId") REFERENCES "DirectorVideoVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DirectorVideoTask" ADD CONSTRAINT "DirectorVideoTask_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "DirectorShot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorVideoTask" ADD CONSTRAINT "DirectorVideoTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorVideoVersion" ADD CONSTRAINT "DirectorVideoVersion_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "DirectorShot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorVideoVersion" ADD CONSTRAINT "DirectorVideoVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DirectorVideoTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorVideoVersion" ADD CONSTRAINT "DirectorVideoVersion_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DirectorKeyframe" ADD CONSTRAINT "DirectorKeyframe_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "DirectorProduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorKeyframe" ADD CONSTRAINT "DirectorKeyframe_selectedImageVersionId_fkey" FOREIGN KEY ("selectedImageVersionId") REFERENCES "DirectorImageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DirectorImageTask" ADD CONSTRAINT "DirectorImageTask_keyframeId_fkey" FOREIGN KEY ("keyframeId") REFERENCES "DirectorKeyframe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorImageTask" ADD CONSTRAINT "DirectorImageTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorImageVersion" ADD CONSTRAINT "DirectorImageVersion_keyframeId_fkey" FOREIGN KEY ("keyframeId") REFERENCES "DirectorKeyframe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorImageVersion" ADD CONSTRAINT "DirectorImageVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DirectorImageTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectorImageVersion" ADD CONSTRAINT "DirectorImageVersion_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
