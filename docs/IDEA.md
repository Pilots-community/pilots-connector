> **Superseded.** This is the original sketch from the 2026-08-20 meeting, kept for provenance.
> The authoritative design is [ARCHITECTURE.md](ARCHITECTURE.md), [PROTOCOL.md](PROTOCOL.md) and
> [DEFINITIONS.md](DEFINITIONS.md). Where they differ from this file, they are right and this file
> is history — in particular: quotations and service instances are one primitive, not two;
> delivery is negotiated per connection rather than per request; and both ETags and hash chains
> are used, for different purposes.

# Context

So we're building a demonstrator of a process sharing engine is the context of the PILOTS project. 
The core idea is that we build a unified engine that allows 2 or more logistics companies to collaborate on a process from start to finish in a unified way, running the same components and infrastructure (partly). 

E.g. let's look at a simple example. We have 2 parties, the Shipper (acts as customer) and the Transporter (acts as supplier). The Shipper want to get a container transported from point A to point B. It requests a quotation from the Transporter for this specific case, and receives a price. Then the transport is executed, thus completing the process. Sounds simple, yet even for this simple process every Transporter has their own procedures and integrations, if any. 

So what we envision in the project is a way to unify this process in a way that everyone can speak the same language, yet can adhere to their own processes. 

# Functional Components

## Quotation / Contract 

Before a process can start, the quotation process happens, just like in real life. We have a `serviceRequest` and need a resulting `quotation` that serves as the contract to execute the `process`. A process is always something that the supplier side offers in their `serviceOffering`, a list of services with either standing or custom quotation flows. 

### Standing quotation / contract

This is the simplest form of a quotation or contract. What you see is what you get. In logistics a good example is Certiweight, a weighing company that weighs your container before shipping and provides a Verified Gross Mass (VGM) certificate to the carrier, mainly as a legal document making sure you are not liable as a shipper for the container being misloaded due to the actual weight not matching the reported weight (if self-reported). 

So in the case of Certiweight they offer a simple service with a standing quotation: if you show up on a weighing site and get your container weighed, they will sent the VGM to the carrier once payment has been received. The payment is of a fixed amount defined by Certiweights pricelist, in our case stored in the standing quotation.

The params of a standing quotation are (not limited to):
- id -> for referencing in serviceRequest and serviceInstance
- price -> value and currency
- linked service definition -> a service provider will always have a list of services they offer
- validity of quotation -> old quotations remain available yet are invalidated for future serviceRequests
- validity parameters -> e.g if the supplier has different prices for different conditions (e.g location of service, type of container, etc.) this offering might be limited to certain conditions defined in the service offering

### Dynamic quotation

Quite similar to the standing quotation, yet there is still mutual acknowledgement to be completed and works as its own process. For example the container transport request mentioned earlier. The Shipper requests a transport and provides info like pickup location, dropoff location, requested execution timing, etc. As defined as required/requested input by the service offering. 

Then a custom quotation is created that needs a response from the supplier with a price and/or specific changes. E.g. a different time of execution because the planning does not allow for it. 

This object is therefore a process to be completed on its own, but it can run in parallel of the actual linked process (through the `contractId` stored on the service instance object). But the service instance might not go into a certain part of the execution until the contract process has been concluded. 

## Service

A service is defined by a service offering, hosted by the service provider / supplier, and is converted into a service instance when execution starts. 

### Service offering

Defines:

- Name of the process
- Id of the process
- Linked quotations or quotation processes to follow
- States of the process
- State transitions and it's conditions
- Roles and permissions of all involved parties, and who can do what
- A full data model / semantic representation of the service instance object -> most state transitions rely on involved parties updating the service instance object's fields. E.g. Certiweight at some point will update the VGM field once payment has been received 

### Service instance

Is created once the service starts and adheres to the service offering definition agreed on before

# Technical requirements

## Functional separation

We envision a setup where there are required components and optional ones. 

Both the consumer (customer) and producer (supplier) are running the same connector, which enables basic communication between the 2 parties. This will be based on a Server Sent Events pattern that funtionally works like this. 

- The supplier side will always own the objects for quotations/contracts/services. The customer references them. So there is one single source of truth, yet both sides should always be able to cryptographically trust each other's data. Etags can be used, or blockchain like sequential hashes, to be refined later
- Functionally a flow might go like this:
    - A customer requests a quotation and provides details as required, and immediately receives an `Accepted` response including a reference to the newly created quotation. A callback url of the customer connector is provided. 
    - The supplier evaluates the request as they are triggered by the connector that a new request came in. It results in the quotation to be updated or even finalised. 
        - This trigger is configurable in the connector. Can be a webhook to an internal service, can also just be a frontend is used directly integrating with the connector to manually accept requests. Let's assume the customer has a simple setup and the supplier a more complex backoffice. Details below. 
    - The connector automatically sends an update to the customer as the quotation process received an update. 
    - The customer can then again contact the supplier by accepting the quotation or requesting changes
    - ... process can go back and forth
    - Once the quotation process gets to an executionable state, the service instance is created at the supplier side and thus the customer is informed again


High level connectivity drawing:

    customer (person) <-manually checks-> connector dashboard UI <-integrates with-> customer connector service <=connects over the internet=> supplier connector service <-webhook integration-> backoffice service running rule engine and integrating with internal tooling <--> ... (whatever internal services run here, we don't care)

The same kind of procedure happens on the service instance, both parties can update the state of the process as long as the owning connector (in this case the supplier's connector) allows it. Meaning the requesting entity is allowed to change a certain field, and then all relevant parties should receive the update as well. 

The connector of the customer does not store the full objects per se, but acts as a proxy to the supplier's connector.

## Eventual consistency

Eventual consistency is very important, so something like etags or hashes need to be used to make sure changes are made sequential and no race conditions can arise

## Data ownership

The supplier owns the objects, yet the customer should always be able to request changes to it, if their permissions and authentication allows it. 

# Tech stack

- Backend for the connector: NodeJS / Typescript together with a simple framework like Fastify or NestJS
- Authentication: Ideally something that can support verifiable credentials, e.g. using DIDs where the hoster of a connector can self identify as long as they are whitelisted by the other connectors they are connecting with. Similar to SSL where you can verify that a request comes from a domain. If possible use something like Better Auth or Consensys' Web3Signer, but advise me.
- Frontend for manual interaction with the connector: Simple React will do fine, use Shadcn for component lib

For now we will not be running a rule engine on the supplier side, they will run a frontend as well. Optimised for local setup if will therefore look a bit like:

    connector UI (customer | localhost:3000) <--> connector service (customer | localhost:3001) <==> connector service (supplier | localhost:3002) <--> connector UI (supplier | localhost:3003)

Each connector service has a database as well, let's make it a simple SQLite for starters, but wrap it so we can change it later to anything we want.


# Open decisions to be made

- We use different terms here mixed together like customer/consumer/requestor vs producer/supplier/executor. Come up with a good name for both sides, knowing that both are running the same connector code, but acting as different roles
- Service offering and contract objects still to be defined
