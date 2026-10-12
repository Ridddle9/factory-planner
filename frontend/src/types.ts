export interface Workshop {
  id: string
  name: string
}

export interface ProductCategory {
  id: string
  name: string
  capacityPerTeamPerDay: number
  workshopId: string
  workshop?: Workshop
}

export interface ProductTeamCapacity {
  id: string
  teamId: string
  capacityPerDay: number
  team: { id: string; name: string }
}

export interface Product {
  id: string
  code: string
  name: string
  categoryId: string
  category?: ProductCategory
  capacityPerDay?: number | null
  capacityLocked?: boolean
  teamCapacities?: ProductTeamCapacity[]
}

export interface Team {
  id: string
  name: string
  headcount: number
}

export interface Order {
  id: string
  orderNumber: string
  customer: string
  description: string | null
  manager: string | null
  paymentTerms: string | null
  approvedAt: string | null
  priority: number
  raytecDate: string | null
  items?: OrderItem[]
}

export interface OrderItem {
  id: string
  orderId: string
  productId: string
  quantity: number
  groupNumber: number | null
  remainingQuantity?: number
  order?: Order
  product?: Product
}

export interface CategoryBlock {
  id: string
  categoryId: string
  startDate: string
  endDate: string
  reason: string | null
}

export interface TeamDayCapacity {
  id: string
  teamId: string
  date: string
  factor: number
  note: string | null
  team?: Team
}

export interface DailyTask {
  id: string
  orderItemId: string
  teamId: string | null
  date: string
  plannedQuantity: number
  actualQuantity: number | null
  comment: string | null
  orderItem?: OrderItem & { order?: Order; product?: Product & { category?: ProductCategory & { workshop?: Workshop } } }
  team?: Team | null
}
