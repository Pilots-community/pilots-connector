# Discussion

Instances:
- Quotation/Contract instance
    - defines price and way of working
    - Results in `quotationId`
    - This process can remain in progress, and does not block actual process execution
    - Can be a standing quotation, e.g. "I offer service X for a static price (example: Certiweight)"
- Process/Service instance
    - Starts with `quotationId`
    - Owned by supplier, triggered by customer/initiator


Consumer/producer pattern

Basis of technical concept is Server Sent Events (SSE)
- Customer sends service request, including webhook for return events
- Supplier accepts request -> Simple `OK` 
- Supplier processes request with customer backend
- Supplier sends response on return webhook

Both supplier and customer run the same connector
The supplier hosts the service object/instance and the customer just stores the reference to the object of the supplier

Version is stored on object at supplier to solve eventual inconsistency. ETAG hash can be used 

# Definitions

## Service

- id
- name
- quotationId
- BPMN ~ can be simplified 
    - states
    - activities
- semantics/data model
- roles/permissions
- state / data (actual instance of the object)

## Quotation

- Clausule / conditionals
- Activities
- Price

# Tasks

- NestJS backend demonstrating SSE: quotations and service instances
- Next/React frontend for manual acceptance of changes
- Maybe also an automatic acceptance service to demonstrate a BPMN engine running in the backend


Make it ready to accept ODRL/JSONLD