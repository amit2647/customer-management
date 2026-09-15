# Customer Management

MVP demonstrating a **Service-Oriented Architecture (SOA)** for customer and lead management.

The platform demonstrates how an **API Gateway** can provide a stable frontend-facing API while independent backend services manage separate business capabilities.

The project is organized as a **multi-repository architecture**. Each service is maintained as an independent Git repository, while the `customer-management` repository acts as the parent repository and uses **Git submodules** to assemble the complete application.

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

### Email Communication

The Email Service provides email as a communication channel for leads and customers.

Current capabilities include:

- SMTP-based email delivery
- Email API
- Customer/lead communication support
- Email templates
- Separate email service
- Extensible architecture for future email automation

Future email capabilities can include:

- Automated follow-up emails
- Welcome emails
- Lead nurturing sequences
- Customer notifications
- Scheduled emails
- Event-triggered email automation
- Email communication history

### Dashboard

The Dashboard Service provides aggregated information for the application dashboard.

It is responsible for:

- Dashboard metrics
- Aggregated service data
- Redis-based caching
- Dashboard API endpoints

### Identity and Access Management

The Identity Service provides authentication and authorization capabilities.

Responsibilities include:

- User authentication
- JWT-based authentication
- User management
- Organization management
- Role management
- Permission management
- Role-based access control

---

# Lead Conversion

A qualified lead can be converted into a customer.

The conversion workflow is:

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

---

# Architecture

```text
                              Browser
                                 |
                                 | HTTP :3000
                                 v
                         +---------------+
                         | React / Vite  |
                         |   Frontend    |
                         +-------+-------+
                                 |
                                 | REST API
                                 v
                         +---------------+
                         |     Kong      |
                         | API Gateway   |
                         |    :8080      |
                         +-------+-------+
                                 |
             +-------------------+-------------------+
             |          |          |        |        |
             v          v          v        v        v
       +---------+ +---------+ +---------+ +------+ +---------+
       |  Lead   | |Customer | | Service | |Email | |Identity |
       | Service | | Service | | Service | |Service| | Service |
       |  :4001  | |  :4002  | |  :4003  | | :4006 | |  :4004 |
       +----+----+ +----+----+ +----+----+ +------+ +---------+
            |           |           |
            +-----------+-----------+
                        |
                        v
                 +-------------+
                 | PostgreSQL  |
                 |     DB      |
                 +-------------+

                         +-------------+
                         |    Redis    |
                         |   Cache     |
                         +-------------+
                                |
                                v
                        Dashboard Service
```

> Port numbers are based on the current Docker Compose configuration. Verify `docker-compose.yml` if ports are changed.

---

# Service-Oriented Architecture

The application separates business capabilities into independent services.

```text
+---------------------+
|   Customer Mgmt     |
|   Parent Project    |
+----------+----------+
           |
           +-------------------+
           |                   |
           v                   v
     +-----------+       +-----------+
     | Lead      |       | Customer  |
     | Service   |       | Service   |
     +-----------+       +-----------+
           |
           +-----------+
           |           |
           v           v
     +-----------+ +-----------+
     | Service   | |   Email   |
     | Catalog   | |  Service  |
     +-----------+ +-----------+

     +-----------+       +-----------+
     | Identity  |       | Dashboard |
     | Service   |       | Service   |
     +-----------+       +-----------+
```

Each service has its own:

- Source code
- Git repository
- Git history
- Dockerfile
- `package.json`
- API
- Business logic
- Database access layer

---

# Components

## Frontend

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

## Kong API Gateway

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

```text
/api/*
       |
       v
Other backend services
```

The gateway provides a stable API boundary for the frontend and hides internal service addresses.

---

# Backend Services

## Lead Service

**Port:** `4001`

Responsibilities:

- Lead management
- Lead search
- Lead scoring
- Lead status management
- Lead/service relationships
- Lead conversion
- Lead validation
- Organization/user ownership

Main API:

```http
GET    /leads
GET    /leads/:id
POST   /leads
PATCH  /leads/:id
DELETE /leads/:id
GET    /leads/:id/services
PUT    /leads/:id/services
POST   /leads/:id/convert
```

Repository:

```text
lead-service
```

---

## Customer Service

**Port:** `4002`

Responsibilities:

- Customer management
- Customer search
- Customer details
- Customer/service relationships
- Customer validation
- Organization/user ownership

Main API:

```http
GET    /customers
GET    /customers/:id
POST   /customers
PUT    /customers/:id
DELETE /customers/:id
GET    /customers/:id/services
PUT    /customers/:id/services
```

Repository:

```text
customer-service
```

---

## Service Service

**Port:** `4003`

Responsibilities:

- Service catalog management
- Service creation
- Service search
- Service updates
- Service activation/deactivation
- Service deletion

Main API:

```http
GET    /services
GET    /services/:id
POST   /services
PUT    /services/:id
DELETE /services/:id
```

Repository:

```text
service-service
```

---

## Identity Service

The Identity Service provides authentication and authorization.

Responsibilities:

- Login
- JWT generation
- Authentication
- User management
- Organization management
- Role management
- Permission management
- Authorization

Repository:

```text
identity-service
```

---

## Email Service

The Email Service provides email-based communication capabilities.

Responsibilities:

- SMTP configuration
- Email sending
- Email templates
- Lead communication
- Customer communication
- Email service APIs

Repository:

```text
email-service
```

The service is designed to evolve into a broader communication service supporting email automation and communication workflows.

---

## Dashboard Service

The Dashboard Service provides aggregated dashboard data.

Responsibilities:

- Dashboard metrics
- Data aggregation
- Redis caching
- Dashboard API

Repository:

```text
dashboard-service
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

# Data Model

The application uses PostgreSQL.

Database:

```text
customer_management
```

The core business entities are:

```text
+----------+
|  leads   |
+----+-----+
     |
     | lead_services
     |
     v
+----------+
| services |
+----+-----+
     ^
     |
     | customer_services
     |
+----+-------+
| customers |
+----------+
```

---

## Tables

### `leads`

Stores prospect information.

Important fields:

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

Important fields:

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

Important fields:

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

# Authentication and Authorization

The platform includes an Identity Service providing JWT-based authentication and role/permission management.

The authorization model includes roles such as:

- Super Admin
- Operations Manager
- Marketing Manager
- Marketing Specialist
- Sales Manager
- Sales Representative
- Customer Support Agent
- Customer Success Manager

Permissions are applied at the service/API level.

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

---

# Docker Deployment

The application is designed to run using Docker Compose.

## Requirements

Install:

- Docker
- Docker Compose

Node.js 20+ is required if running individual services without Docker.

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

Check running containers:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs -f
```

View logs for a specific service:

```bash
docker compose logs -f email-service
```

---

# Application URLs

Frontend:

```text
http://localhost:3000
```

API Gateway:

```text
http://localhost:8080
```

Kong proxy:

```text
http://localhost:8080
```

---

# Docker Services

The Docker Compose environment contains the following major components:

| Component         |                  Port | Purpose                          |
| ----------------- | --------------------: | -------------------------------- |
| Frontend          |                  3000 | React application                |
| Kong              |                  8080 | API Gateway                      |
| Lead Service      |                  4001 | Lead management                  |
| Customer Service  |                  4002 | Customer management              |
| Service Service   |                  4003 | Service catalog                  |
| Identity Service  |                  4004 | Authentication and authorization |
| Dashboard Service | configured in Compose | Dashboard aggregation            |
| Email Service     | configured in Compose | Email communication              |
| PostgreSQL        |                  5432 | Database                         |
| Redis             | configured in Compose | Dashboard caching                |
| pgAdmin           |                  5050 | Optional database administration |

> The authoritative port configuration is `docker-compose.yml`.

---

# Service Dependencies

The high-level dependency structure is:

```text
                     PostgreSQL
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
    Lead Service   Customer Service  Service Service
          |              |
          +--------------+
                 |
                 v
          Business APIs
                 |
                 v
            Kong Gateway
                 |
        +--------+--------+
        |                 |
        v                 v
    Frontend        External Clients


       Redis
         |
         v
 Dashboard Service


 SMTP Provider
      |
      v
 Email Service
```

---

# Health Checks

Backend services expose health endpoints.

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

Example:

```json
{
  "service": "lead-service",
  "status": "ok",
  "database": "postgresql"
}
```

---

# Project Structure

The parent repository uses Git submodules for the independently maintained services.

```text
customer-management/
│
├── .git/
├── .gitmodules
│
├── docker-compose.yml
├── README.md
│
├── kong/
│   └── ...
│
├── lead-service/
│   └── ...
│
├── customer-service/
│   └── ...
│
├── service-service/
│   └── ...
│
├── identity-service/
│   └── ...
│
├── dashboard-service/
│   └── ...
│
├── email-service/
│   └── ...
│
└── frontend/
    └── ...
```

---

# Repository Architecture

The project consists of a parent repository and independent service repositories.

| Local Directory       | GitHub Repository        | Purpose                          |
| --------------------- | ------------------------ | -------------------------------- |
| `customer-management` | `customer-management`    | Parent/orchestration repository  |
| `customer-service`    | `customer-service`       | Customer management              |
| `dashboard-service`   | `dashboard-service`      | Dashboard aggregation            |
| `email-service`       | `email-service`          | Email communication              |
| `frontend`            | `customer_mgmt_frontend` | React frontend                   |
| `identity-service`    | `identity-service`       | Authentication and authorization |
| `kong`                | `api_gateway`            | Kong API Gateway configuration   |
| `lead-service`        | `lead-service`           | Lead management                  |
| `service-service`     | `service-service`        | Service catalog                  |

Each service maintains its own Git history and can be developed and deployed independently.

---

# Git Submodules

The parent repository uses Git submodules to reference the service repositories.

Check submodules:

```bash
git submodule status
```

Initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

Clone the complete project:

```bash
git clone --recurse-submodules git@github.com-amit2647:amit2647/customer-management.git
```

If the parent repository has already been cloned:

```bash
git submodule update --init --recursive
```

---

## Working with a Service

Each service is an independent Git repository.

For example:

```bash
cd email-service
```

Make changes and commit them:

```bash
git add .
git commit -m "Add email automation"
git push
```

Then update the parent repository's reference:

```bash
cd ..

git add email-service
git commit -m "Update email-service"
git push
```

The child repository contains the actual service history, while the parent repository records the exact service commit used by the overall application.

---

# Running Without Docker

Each backend service can be run independently.

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

> For development, credentials should preferably be supplied through environment variables rather than committed directly to source control.

PostgreSQL data is persisted using a Docker volume.

---

# Architectural Principles

## Service Separation

Business capabilities are separated into independent services:

```text
Lead Service
Customer Service
Service Service
Identity Service
Email Service
Dashboard Service
```

Each service exposes its own API and encapsulates its business logic.

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
   |
   +---- Identity Service
   |
   +---- Dashboard Service
   |
   +---- Email Service
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
  +-- Create customer
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

# Purpose

This project is intended as an demonstration of:

- Service-Oriented Architecture
- Microservice-style decomposition
- API Gateway patterns
- RESTful APIs
- JWT authentication
- Role-based access control
- Database persistence
- Relational data modelling
- Many-to-many relationships
- Transaction management
- Docker containerization
- Docker Compose
- Frontend/backend separation
- Service-to-service communication
- Email communication
- Caching with Redis
- Business workflow implementation
- Git submodule-based multi-repository architecture

It is an MVP and is **not intended to represent a production-ready enterprise CRM**.

---

# Future Improvements

Potential future enhancements include:

### Communication

- Email communication history
- Email automation
- Scheduled emails
- Lead nurturing workflows
- SMS integration
- WhatsApp integration
- Omni-channel interaction history
- Communication templates
- Event-triggered communication

### CRM

- Lead assignment to sales representatives
- Customer lifecycle management
- Customer activity timeline
- Opportunity management
- Tasks and reminders
- Advanced lead scoring

### Platform

- API rate limiting
- Centralized observability
- Distributed tracing
- Message broker integration
- Event-driven architecture
- Dedicated database per service
- Service-to-service authentication
- Automated testing
- CI/CD pipeline
- Kubernetes deployment
- Secrets management

### AI

Potential future AI capabilities include:

- AI lead qualification
- Lead scoring recommendations
- Customer insights
- Email generation
- Automated email follow-ups
- Conversational CRM assistant
- Natural-language CRM operations
- AI-powered dashboard insights
- MCP-based application agent

---

# Technology Stack

| Layer                   | Technology           |
| ----------------------- | -------------------- |
| Frontend                | React                |
| Build Tool              | Vite                 |
| Routing                 | React Router         |
| Language                | JavaScript           |
| Backend                 | Node.js              |
| API Framework           | Express              |
| API Gateway             | Kong                 |
| Database                | PostgreSQL           |
| Database Driver         | node-postgres (`pg`) |
| Cache                   | Redis                |
| Authentication          | JWT                  |
| Containerization        | Docker               |
| Orchestration           | Docker Compose       |
| Database Administration | pgAdmin              |
| Email                   | SMTP                 |
| Version Control         | Git                  |
| Repository Architecture | Git Submodules       |

---

# License

This project is an MVP created for educational and demonstration purposes.
