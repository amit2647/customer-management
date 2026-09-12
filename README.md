# Customer Management

Academic MVP demonstrating a **Service-Oriented Architecture (SOA)** for customer and lead management.

The application demonstrates how an API Gateway can provide a stable frontend-facing API while independent backend services manage separate business capabilities.

---

## Features

### Lead Management

- Create leads
- List leads
- Search leads
- View lead details
- Update lead information
- Update lead status
- Lead scoring
- Track lead acquisition channel
- Assign multiple services to leads
- Remove services from leads
- Convert qualified leads into customers
- Delete leads

### Customer Management

- Create customers
- List customers
- Search customers
- View customer details
- Update customer information
- Assign multiple services to customers
- Remove services from customers
- Delete customers
- Display assigned services

### Service Management

- Create services
- List services
- Search services
- View service details
- Update services
- Activate/deactivate services
- Delete services
- Assign services to leads
- Assign services to customers

### Lead Conversion

A qualified lead can be converted into a customer.

The conversion workflow:

```text
Qualified Lead
      |
      | Convert
      v
Customer Created
      |
      +---- Customer information copied
      |
      +---- Lead services copied
      |
      v
Lead marked as Converted
```

The conversion operation is performed transactionally so that the customer creation, service mapping, and lead status update succeed or fail together.

### Architecture

- Service-Oriented Architecture (SOA)
- Kong API Gateway
- Independent Lead Service
- Independent Customer Service
- Independent Service Catalog Service
- PostgreSQL persistence
- REST APIs
- Docker Compose deployment
- React/Vite frontend
- Service-to-service data relationships
- Many-to-many lead/service mapping
- Many-to-many customer/service mapping

---

# Architecture

```text
                         Browser
                            |
                            | HTTP :3000
                            v
                    +----------------+
                    | React Frontend |
                    +----------------+
                            |
                            | REST API
                            v
                    +----------------+
                    |  Kong Gateway  |
                    |     :8080      |
                    +----------------+
                       /      |      \
                      /       |       \
                     v        v        v
              +---------+ +---------+ +---------------+
              |  Lead   | |Customer | |    Service    |
              | Service | | Service | |    Service    |
              | :4001   | | :4002   | |    :4003      |
              +---------+ +---------+ +---------------+
                   \          |             /
                    \         |            /
                     +--------+-----------+
                              |
                              v
                       +-------------+
                       | PostgreSQL  |
                       |     DB      |
                       +-------------+
```

## Components

### Frontend

The frontend is implemented using:

- React
- Vite
- React Router
- JavaScript
- CSS

The browser communicates with the backend through the Kong API Gateway rather than directly accessing individual services.

Frontend:

```text
http://localhost:3000
```

---

### Kong API Gateway

Kong acts as the API Gateway between the frontend and backend services.

Gateway:

```text
http://localhost:8080
```

Example routing:

```text
/api/leads/*

        |
        v

Lead Service :4001
```

```text
/api/customers/*

        |
        v

Customer Service :4002
```

```text
/api/services/*

        |
        v

Service Service :4003
```

The gateway provides a stable API boundary for the frontend and hides internal service addresses.

---

## Backend Services

### Lead Service

Port:

```text
4001
```

Responsibilities:

- Lead management
- Lead search
- Lead scoring
- Lead status management
- Lead/service relationships
- Lead conversion

Main API:

```text
GET    /leads
GET    /leads/:id
POST   /leads
PATCH  /leads/:id
DELETE /leads/:id

GET    /leads/:id/services
PUT    /leads/:id/services

POST   /leads/:id/convert
```

---

### Customer Service

Port:

```text
4002
```

Responsibilities:

- Customer management
- Customer search
- Customer details
- Customer/service relationships

Main API:

```text
GET    /customers
GET    /customers/:id
POST   /customers
PUT    /customers/:id
DELETE /customers/:id

GET    /customers/:id/services
PUT    /customers/:id/services
```

---

### Service Service

Port:

```text
4003
```

Responsibilities:

- Service catalog management
- Service creation
- Service search
- Service updates
- Service activation/deactivation
- Service deletion

Main API:

```text
GET    /services
GET    /services/:id
POST   /services
PUT    /services/:id
DELETE /services/:id
```

---

# Data Model

The application uses PostgreSQL.

Database:

```text
customer_management
```

The main entities are:

```text
+----------+
|  leads   |
+----------+
     |
     | lead_services
     |
     v
+----------+
| services |
+----------+
     ^
     |
     | customer_services
     |
+-------------+
| customers   |
+-------------+
```

## Tables

### `leads`

Stores prospect information.

Important fields include:

```text
id
name
company
email
phone
channel
status
score
created_at
updated_at
```

---

### `customers`

Stores customer information.

Important fields include:

```text
id
name
company
email
phone
segment
created_at
updated_at
```

---

### `services`

Stores the service catalog.

Important fields include:

```text
id
name
description
category
status
created_at
updated_at
```

---

### `lead_services`

Many-to-many relationship between leads and services.

```text
lead_id
service_id
created_at
```

---

### `customer_services`

Many-to-many relationship between customers and services.

```text
customer_id
service_id
created_at
```

---

# API Examples

## Get Leads

```http
GET /api/leads
```

Search:

```http
GET /api/leads?q=priya
```

---

## Create Lead

```http
POST /api/leads
Content-Type: application/json
```

Example:

```json
{
  "name": "John Smith",
  "company": "ABC Ltd",
  "email": "john@example.com",
  "phone": "9876543210",
  "channel": "Website",
  "status": "New",
  "score": 50,
  "serviceIds": [1, 2]
}
```

---

## Assign Services to Lead

```http
PUT /api/leads/1/services
Content-Type: application/json
```

```json
{
  "serviceIds": [1, 2, 4]
}
```

Sending an empty array removes all service mappings:

```json
{
  "serviceIds": []
}
```

---

## Convert Lead

```http
POST /api/leads/1/convert
```

The conversion:

1. Finds the lead.
2. Verifies that it has not already been converted.
3. Creates a customer.
4. Copies the lead's customer information.
5. Copies the lead's service mappings.
6. Marks the lead as `Converted`.
7. Commits the operation as a transaction.

---

## Get Customers

```http
GET /api/customers
```

Search:

```http
GET /api/customers?q=amit
```

---

## Create Customer

```http
POST /api/customers
Content-Type: application/json
```

Example:

```json
{
  "name": "Amit Sharma",
  "company": "Example Ltd",
  "email": "amit@example.com",
  "phone": "9876543210",
  "segment": "Enterprise",
  "serviceIds": [1, 3]
}
```

---

## Assign Services to Customer

```http
PUT /api/customers/1/services
Content-Type: application/json
```

```json
{
  "serviceIds": [1, 3, 5]
}
```

---

## Get Services

```http
GET /api/services
```

Search:

```http
GET /api/services?q=cloud
```

---

# Docker Deployment

The application is designed to run using Docker Compose.

## Requirements

Install:

- Docker
- Docker Compose

Node.js 20+ is required if running the individual services without Docker.

---

## Run with Docker

From the project root:

```bash
docker compose up --build
```

Or run in detached mode:

```bash
docker compose up --build -d
```

---

## Open the Application

Frontend:

```text
http://localhost:3000
```

API Gateway:

```text
http://localhost:8080
```

---

# Docker Services

The Docker Compose environment contains:

| Component        | Container Port | Purpose                          |
| ---------------- | -------------: | -------------------------------- |
| Frontend         |           3000 | React application                |
| Kong             |           8000 | API Gateway                      |
| Lead Service     |           4001 | Lead management                  |
| Customer Service |           4002 | Customer management              |
| Service Service  |           4003 | Service catalog                  |
| PostgreSQL       |           5432 | Database                         |
| pgAdmin          |           5050 | Optional database administration |

The Kong container exposes its proxy through:

```text
localhost:8080
```

---

# Project Structure

```text
customer-management/
│
├── docker-compose.yml
│
├── kong/
│   └── kong.yml
│
├── lead-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── server.js
│
├── customer-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── server.js
│
├── service-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── server.js
│
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── index.html
│   └── src/
│       ├── api/
│       │   ├── client.js
│       │   ├── leads.js
│       │   ├── customers.js
│       │   └── services.js
│       │
│       ├── components/
│       │   ├── layout/
│       │   ├── common/
│       │   ├── leads/
│       │   ├── customers/
│       │   └── services/
│       │
│       ├── pages/
│       │   ├── Leads/
│       │   ├── Customers/
│       │   ├── Services/
│       │   └── NotFound/
│       │
│       ├── App.jsx
│       ├── main.jsx
│       └── styles.css
│
└── README.md
```

---

# Running Without Docker

Each backend service can also be run independently.

## Lead Service

```bash
cd lead-service
npm install
npm start
```

Runs on:

```text
http://localhost:4001
```

---

## Customer Service

```bash
cd customer-service
npm install
npm start
```

Runs on:

```text
http://localhost:4002
```

---

## Service Service

```bash
cd service-service
npm install
npm start
```

Runs on:

```text
http://localhost:4003
```

---

## Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend development server runs on the configured Vite port, normally:

```text
http://localhost:3000
```

---

# Database

The application uses PostgreSQL.

Default Docker configuration:

```text
Database: customer_management
User:     app_user
Password: app_password
Host:     postgres
Port:     5432
```

The PostgreSQL data is persisted using a Docker volume:

```text
postgres_data
```

This allows the database to survive container recreation.

---

# Health Checks

Each backend service exposes a health endpoint.

Lead Service:

```http
GET /health
```

Customer Service:

```http
GET /health
```

Service Service:

```http
GET /health
```

Example response:

```json
{
  "service": "lead-service",
  "status": "ok",
  "database": "postgresql"
}
```

---

# Service Dependencies

The Docker environment starts PostgreSQL first.

The service catalog is then initialized because both Lead Service and Customer Service use the `services` table for their many-to-many mappings.

The dependency structure is approximately:

```text
PostgreSQL
    |
    +---- Service Service
    |
    +---- Lead Service
    |
    +---- Customer Service
             |
             v
         Kong Gateway
             |
             v
          Frontend
```

---

# Architectural Principles

This project demonstrates several SOA concepts.

## Service Separation

Business capabilities are separated into independent services:

```text
Lead Service
Customer Service
Service Service
```

Each service exposes its own REST API.

---

## API Gateway

The frontend does not need to know the internal addresses of backend services.

Instead:

```text
Browser
   |
   v
Kong
   |
   +---- Lead Service
   |
   +---- Customer Service
   |
   +---- Service Service
```

This creates a stable API boundary.

---

## Many-to-Many Relationships

A lead can require multiple services:

```text
Lead A
  |
  +-- Cloud Migration
  +-- Data Analytics
```

A service can also be associated with multiple leads:

```text
Cloud Migration
  |
  +-- Lead A
  +-- Lead B
  +-- Lead C
```

The same relationship model is used for customers.

---

## Transactional Operations

Operations involving multiple database changes use PostgreSQL transactions.

For example, lead conversion performs:

```text
BEGIN
  |
  +-- Create/find customer
  |
  +-- Copy service mappings
  |
  +-- Mark lead Converted
  |
COMMIT
```

If an error occurs:

```text
ROLLBACK
```

This prevents partially completed conversions.

---

# Academic Purpose

This project is intended as an academic demonstration of:

- Service-Oriented Architecture
- Microservice-style decomposition
- API Gateway patterns
- RESTful APIs
- Database persistence
- Relational data modelling
- Many-to-many relationships
- Transaction management
- Docker containerization
- Frontend/backend separation
- Business workflow implementation

It is an MVP and is not intended to represent a production-ready enterprise CRM.

---

# Future Improvements

Potential future enhancements include:

- Authentication and authorization
- Role-based access control
- JWT-based security
- Customer activity timeline
- Email and SMS communication tracking
- Omni-channel interaction history
- Lead assignment to sales representatives
- Customer lifecycle management
- Audit logging
- Pagination
- Advanced filtering
- API rate limiting
- Centralized observability
- Distributed tracing
- Message broker integration
- Event-driven lead conversion
- Dedicated database per service
- Service-to-service authentication
- Automated testing
- CI/CD pipeline

---

# Technology Stack

| Layer                   | Technology           |
| ----------------------- | -------------------- |
| Frontend                | React                |
| Build Tool              | Vite                 |
| Routing                 | React Router         |
| Backend                 | Node.js              |
| API Framework           | Express              |
| API Gateway             | Kong                 |
| Database                | PostgreSQL           |
| Database Driver         | node-postgres (`pg`) |
| Containerization        | Docker               |
| Orchestration           | Docker Compose       |
| Database Administration | pgAdmin              |

---

# Roles Matrix

| Role                     | Leads       | Customers | Services | Users  | Organization | Own-record restriction |
| ------------------------ | ----------- | --------- | -------- | ------ | ------------ | ---------------------- |
| Super Admin              | Full        | Full      | Full     | Full   | Full         | No                     |
| Operations Manager       | Full        | Full      | Full     | Manage | Manage       | No                     |
| Marketing Manager        | Full        | Limited   | View     | No     | No           | No                     |
| Marketing Specialist     | Create/View | Limited   | View     | No     | No           | No                     |
| Sales Manager            | Full        | Full      | View     | Team   | No           | No                     |
| Sales Representative     | Own         | Own       | View     | No     | No           | **Yes**                |
| Customer Support Agent   | Limited     | View      | Full     | No     | No           | No                     |
| Customer Success Manager | View        | Full      | View     | No     | No           | No                     |


# License

This project is an academic MVP created for educational and demonstration purposes.
