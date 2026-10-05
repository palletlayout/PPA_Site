export type InventoryAcquisitionMethod = "scanner_capture" | "spreadsheet_import" | "explicit_confirmation" | "legacy_unknown";
export type InventoryProvenance = {
  method: Exclude<InventoryAcquisitionMethod, "legacy_unknown">;
  sourceFile?: string;
  importId?: string;
  rowNumber?: number;
};

/** Production inventory with separately recorded acquisition evidence. */
export type InventoryItem = {
  id: string;
  /** Pallet reference from the inventory file. */
  palletId?: string;
  serial: string;
  partNumber: string;
  /** Compatibility value for the third barcode, preserved with its raw identifier. */
  partMark: string;
  /** Deprecated compatibility field; always empty. */
  partLevel: string;
  /** Optional color, regardless of whether its barcode uses C or 2P. */
  color: string;
  quantity: number;
  unitOfMeasure?: string;
  supplierId?: string;
  receiptKind?: "received" | "expected";
  fulfillmentStage?: "available" | "partially_consumed" | "expected" | "packed" | "loaded" | "dispatched" | "deleted";
  /** Cumulative active allocation quantities; dispatched stock is included in loaded stock. */
  loadedQuantity: number;
  dispatchedQuantity: number;
  /** Completion times for the entire original quantity; null while any quantity remains. */
  loadedAt?: string | null;
  dispatchedAt?: string | null;
  status: string;
  consumedFlag: "Y" | "N";
  consumedQuantity: number;
  remainingQuantity?: number;
  consumedAt: string | null;
  fulfilledDemandId: string | null;
  fulfilledDemandIds?: string[];
  weight: number | null;
  unitCost: number | null;
  receiveDate: string;
  receivedAt: string;
  receivedBy: string;
  acquisitionMethod?: InventoryAcquisitionMethod;
  sourceFile?: string;
  sourceImportId?: string;
  sourceRow?: number | null;
  /** Initial entry timestamp; receiveDate is the source-declared receipt date. */
  recordedAt?: string;
  /** Actual submitted label input only; imports/confirmations never fabricate scans. */
  scannedValuesJson?: string;
  isTest: false;
};

export type InventoryReceiveRequest = {
  captureId: string;
  receiptSessionId: string;
  rawValues: string[];
  operatorName: string;
  unitOfMeasure?: string;
  supplierId?: string;
  palletId?: string;
};

export type InventoryReceiveResult = {
  ok: true;
  created: boolean;
  duplicate: boolean;
  inventory: InventoryItem;
};

export type InventoryListResult = {
  items: InventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  summary: { containers: number; units: number; quantitiesByUnit?: Record<string, number> };
};
