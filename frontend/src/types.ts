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

export interface Product {
  id: string
  code: string
  name: string
  categoryId: string
  category?: ProductCategory
}

export interface Team {
  id: string
  name: string
}

export interface Order {
  id: string
  orderNumber: string
  customer: string
  description: string | null
  dueDate: string | null
  manager: string | null
  paymentTerms: string | null
  approvedAt: string | null
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
