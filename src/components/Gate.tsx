import { Button, LayerCard, Text } from '@cloudflare/kumo';
import { ArrowRightIcon } from '@phosphor-icons/react';

type Props = {
  title: string;
  description: string;
  action: { href: string; label: string };
};

export function Gate({ title, description, action }: Props) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center py-10">
      <LayerCard className="p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <Text variant="heading" size="lg" as="h1">
            {title}
          </Text>
          <Text variant="secondary" as="p">
            {description}
          </Text>
          <form method="get" action={action.href} className="pt-3">
            <Button
              type="submit"
              variant="primary"
              icon={<ArrowRightIcon size={14} />}
              className="w-full"
            >
              {action.label}
            </Button>
          </form>
        </div>
      </LayerCard>
    </div>
  );
}
