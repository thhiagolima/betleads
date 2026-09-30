import { createFileRoute } from "@tanstack/react-router";

import { CampaignsHub } from "@/routes/sms";

export const Route = createFileRoute("/campanhas")({ component: CampaignsPage });

function CampaignsPage() {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-6 p-4 sm:p-6">
      <CampaignsHub />
    </div>
  );
}
