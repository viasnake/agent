import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";

// Assistant UI's Radix tabs composition, styled with the application's Bootstrap tokens.
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({
  className = "",
  ...props
}: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List className={`content-tabs ${className}`} {...props} />
  );
}

export function TabsTrigger({
  className = "",
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger className={`nav-link ${className}`} {...props} />
  );
}
