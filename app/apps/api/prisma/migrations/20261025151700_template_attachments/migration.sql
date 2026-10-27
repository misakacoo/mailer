-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "attachment_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
