import type { FulfillmentSettings } from "./fulfillment-settings.ts";

export type FulfillmentAllocation = {
  id: string;
  inventoryItemId: string;
  serial: string;
  quantity: number;
  packedAt: string;
  packedBy: string;
};

export type CartLine = {
  id: string;
  batchId: string;
  plant: string;
  zone: string;
  areaType: "onsite" | "offsite";
  shipCategory: string;
  loadNumber: string;
  trainNumber: string;
  picklistNumber: string;
  cartNumber: string;
  cartId: string;
  palletId: string;
  cartBarcode: string;
  loadedAt: string | null;
  loadedBy: string;
  dispatchedAt?: string | null;
  dispatchedBy?: string;
  sourceLineId?: string;
  sourceScope?: string;
  unitOfMeasure?: string;
  preferredSupplierId?: string;
  productionQuantity?: number;
  cartMaxQuantity?: number;
  interiorColor?: string;
  exteriorColor?: string;
  vehicleColor?: string;
  programId?: string;
  totalCarts?: number;
  pymtc?: string;
  checksheetNumber?: string;
  sequence: string;
  packSequence?: string;
  option?: string;
  partNumber: string;
  description: string;
  color: string;
  quantity: number;
  /** Serial of the container that fulfilled this independent demand line. */
  aiagSerial: string;
  fulfilledQuantity: number;
  remainingQuantity?: number;
  allocations?: FulfillmentAllocation[];
  fulfilledAt?: string | null;
  fulfilledBy?: string;
  shortClosedAt?: string | null;
  inventoryItemId: string | null;
  masterBarcode?: string;
  movementBarcode?: string;
  caseCode?: string;
  outgoingSerial?: string;
  cartSequenceNumber?: string;
  fromLot?: string;
  toLot?: string;
  model?: string;
  cartType?: string;
  scheduledDispatchDate?: string;
  scheduledDispatchTime?: string;
  deliveryLocation?: string;
  detailDeliveryLocation?: string;
  containerPosition?: string;
  containerType?: string;
  /** Source row metadata, independent from demand identity and required quantity. */
  containerSequence?: string;
  fromModel?: string;
  fromType?: string;
  fromOption?: string;
  fromColor?: string;
  fromInteriorColor?: string;
  fromUnits?: string;
  toModel?: string;
  toType?: string;
  toOption?: string;
  toColor?: string;
  toInteriorColor?: string;
  toUnits?: string;
  pickingLocation?: string;
  mcid?: string;
  containerTotal?: number;
  chassisNumber?: string;
  orderNumber?: string;
  batchNumber?: string;
  loadingSequence?: string;
  status: "pending" | "active" | "verified" | "short";
  verifiedAt: string | null;
};

export type ImportRow = Omit<
  CartLine,
  "id" | "batchId" | "cartBarcode" | "loadedAt" | "loadedBy" | "dispatchedAt" | "dispatchedBy" | "status" | "verifiedAt" | "fulfilledQuantity" | "inventoryItemId" | "remainingQuantity" | "allocations" | "fulfilledAt" | "fulfilledBy" | "shortClosedAt"
>;

export type DemandLinePatch = Partial<ImportRow>;

export type CartLock = {
  cartKey: string;
  picklistKey: string;
  operatorName: string;
  acquiredAt: string;
  expiresAt: string;
  isOwned: boolean;
  /** The authenticated user owns this lease, including a different browser session. */
  isOwnedByOperator?: boolean;
};

export type ScanEvent = {
  id: string;
  lineId: string;
  cartKey: string;
  field: string;
  scannedValue: string;
  matched: number;
  isTest: number;
  operatorName: string;
  createdAt: string;
};

export type AppState = {
  settings: FulfillmentSettings;
  lines: CartLine[];
  locks: CartLock[];
  events: ScanEvent[];
  lastImport: {
    fileName: string;
    rowCount: number;
    importedAt: string;
  } | null;
};
