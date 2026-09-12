Yes. Let's write a **complete but interview-friendly C++ Parking Lot design**.

I'm deliberately keeping it clean rather than adding unnecessary production complexity. The goal is that you can **understand and explain every class in a Microsoft interview**.

## 1. Complete code

```cpp
#include <iostream>
#include <vector>
#include <memory>
#include <string>
#include <unordered_map>
#include <chrono>
#include <stdexcept>

using namespace std;

// ============================================================
// 1. VEHICLE
// ============================================================

enum class VehicleType {
    BIKE,
    CAR,
    TRUCK
};

class Vehicle {
protected:
    string licenseNumber;
    VehicleType type;

public:
    Vehicle(const string& licenseNumber, VehicleType type)
        : licenseNumber(licenseNumber), type(type) {}

    virtual ~Vehicle() = default;

    string getLicenseNumber() const {
        return licenseNumber;
    }

    VehicleType getType() const {
        return type;
    }
};

class Bike : public Vehicle {
public:
    Bike(const string& licenseNumber)
        : Vehicle(licenseNumber, VehicleType::BIKE) {}
};

class Car : public Vehicle {
public:
    Car(const string& licenseNumber)
        : Vehicle(licenseNumber, VehicleType::CAR) {}
};

class Truck : public Vehicle {
public:
    Truck(const string& licenseNumber)
        : Vehicle(licenseNumber, VehicleType::TRUCK) {}
};


// ============================================================
// 2. PARKING SPOT
// ============================================================

enum class SpotType {
    BIKE,
    CAR,
    TRUCK
};

class ParkingSpot {
private:
    int id;
    SpotType type;
    Vehicle* vehicle;

public:
    ParkingSpot(int id, SpotType type)
        : id(id), type(type), vehicle(nullptr) {}

    int getId() const {
        return id;
    }

    SpotType getType() const {
        return type;
    }

    bool isFree() const {
        return vehicle == nullptr;
    }

    bool canFit(Vehicle* vehicle) const {
        if (vehicle == nullptr || !isFree()) {
            return false;
        }

        if (vehicle->getType() == VehicleType::BIKE &&
            type == SpotType::BIKE) {
            return true;
        }

        if (vehicle->getType() == VehicleType::CAR &&
            type == SpotType::CAR) {
            return true;
        }

        if (vehicle->getType() == VehicleType::TRUCK &&
            type == SpotType::TRUCK) {
            return true;
        }

        return false;
    }

    void parkVehicle(Vehicle* vehicle) {
        if (!canFit(vehicle)) {
            throw runtime_error("Vehicle cannot be parked here");
        }

        this->vehicle = vehicle;
    }

    void removeVehicle() {
        vehicle = nullptr;
    }

    Vehicle* getVehicle() const {
        return vehicle;
    }
};


// ============================================================
// 3. PARKING FLOOR
// ============================================================

class ParkingFloor {
private:
    int floorNumber;
    vector<unique_ptr<ParkingSpot>> spots;

public:
    ParkingFloor(int floorNumber)
        : floorNumber(floorNumber) {}

    void addSpot(
        int spotId,
        SpotType spotType
    ) {
        spots.push_back(
            make_unique<ParkingSpot>(spotId, spotType)
        );
    }

    int getFloorNumber() const {
        return floorNumber;
    }

    vector<unique_ptr<ParkingSpot>>& getSpots() {
        return spots;
    }
};


// ============================================================
// 4. PARKING STRATEGY
// ============================================================

class ParkingStrategy {
public:
    virtual ParkingSpot* findSpot(
        vector<unique_ptr<ParkingFloor>>& floors,
        Vehicle* vehicle
    ) = 0;

    virtual ~ParkingStrategy() = default;
};


// First available suitable spot
class FirstAvailableStrategy : public ParkingStrategy {
public:
    ParkingSpot* findSpot(
        vector<unique_ptr<ParkingFloor>>& floors,
        Vehicle* vehicle
    ) override {

        for (auto& floor : floors) {
            for (auto& spot : floor->getSpots()) {

                if (spot->canFit(vehicle)) {
                    return spot.get();
                }
            }
        }

        return nullptr;
    }
};


// ============================================================
// 5. TICKET
// ============================================================

class Ticket {
private:
    int ticketId;
    Vehicle* vehicle;
    ParkingSpot* spot;

    chrono::system_clock::time_point entryTime;

public:
    Ticket(
        int ticketId,
        Vehicle* vehicle,
        ParkingSpot* spot
    )
        : ticketId(ticketId),
          vehicle(vehicle),
          spot(spot),
          entryTime(chrono::system_clock::now()) {}

    int getTicketId() const {
        return ticketId;
    }

    Vehicle* getVehicle() const {
        return vehicle;
    }

    ParkingSpot* getSpot() const {
        return spot;
    }

    chrono::system_clock::time_point getEntryTime() const {
        return entryTime;
    }
};


// ============================================================
// 6. FEE STRATEGY
// ============================================================

class FeeStrategy {
public:
    virtual double calculateFee(
        const Ticket& ticket
    ) = 0;

    virtual ~FeeStrategy() = default;
};


// Simple hourly pricing
class HourlyFeeStrategy : public FeeStrategy {
private:
    double bikeRate;
    double carRate;
    double truckRate;

public:
    HourlyFeeStrategy(
        double bikeRate,
        double carRate,
        double truckRate
    )
        : bikeRate(bikeRate),
          carRate(carRate),
          truckRate(truckRate) {}

    double calculateFee(
        const Ticket& ticket
    ) override {

        auto now = chrono::system_clock::now();

        auto duration =
            chrono::duration_cast<chrono::hours>(
                now - ticket.getEntryTime()
            );

        long long hours = duration.count();

        // Minimum one hour
        hours = max(1LL, hours);

        VehicleType type =
            ticket.getVehicle()->getType();

        double rate;

        if (type == VehicleType::BIKE) {
            rate = bikeRate;
        }
        else if (type == VehicleType::CAR) {
            rate = carRate;
        }
        else {
            rate = truckRate;
        }

        return hours * rate;
    }
};


// ============================================================
// 7. PAYMENT
// ============================================================

enum class PaymentType {
    CASH,
    CARD,
    UPI
};

class Payment {
public:
    virtual void pay(double amount) = 0;

    virtual ~Payment() = default;
};


class CashPayment : public Payment {
public:
    void pay(double amount) override {
        cout << "Paid ₹" << amount
             << " using Cash\n";
    }
};


class CardPayment : public Payment {
public:
    void pay(double amount) override {
        cout << "Paid ₹" << amount
             << " using Card\n";
    }
};


class UPIPayment : public Payment {
public:
    void pay(double amount) override {
        cout << "Paid ₹" << amount
             << " using UPI\n";
    }
};


// ============================================================
// 8. PAYMENT FACTORY
// ============================================================

class PaymentFactory {
public:
    static unique_ptr<Payment> createPayment(
        PaymentType type
    ) {

        switch (type) {

        case PaymentType::CASH:
            return make_unique<CashPayment>();

        case PaymentType::CARD:
            return make_unique<CardPayment>();

        case PaymentType::UPI:
            return make_unique<UPIPayment>();
        }

        throw invalid_argument("Invalid payment type");
    }
};


// ============================================================
// 9. PARKING LOT
// ============================================================

class ParkingLot {
private:
    vector<unique_ptr<ParkingFloor>> floors;

    unique_ptr<ParkingStrategy> parkingStrategy;
    unique_ptr<FeeStrategy> feeStrategy;

    int nextTicketId = 1;

    unordered_map<int, unique_ptr<Ticket>> activeTickets;

public:

    ParkingLot(
        unique_ptr<ParkingStrategy> parkingStrategy,
        unique_ptr<FeeStrategy> feeStrategy
    )
        : parkingStrategy(move(parkingStrategy)),
          feeStrategy(move(feeStrategy)) {}

    // --------------------------------------------------------
    // Add floor
    // --------------------------------------------------------

    void addFloor(int floorNumber) {

        floors.push_back(
            make_unique<ParkingFloor>(floorNumber)
        );
    }

    // --------------------------------------------------------
    // Get floor
    // --------------------------------------------------------

    ParkingFloor* getFloor(int floorNumber) {

        for (auto& floor : floors) {

            if (floor->getFloorNumber() == floorNumber) {
                return floor.get();
            }
        }

        return nullptr;
    }

    // --------------------------------------------------------
    // Park vehicle
    // --------------------------------------------------------

    Ticket* parkVehicle(Vehicle* vehicle) {

        ParkingSpot* spot =
            parkingStrategy->findSpot(
                floors,
                vehicle
            );

        if (spot == nullptr) {
            cout << "No suitable parking spot available\n";
            return nullptr;
        }

        // Park vehicle
        spot->parkVehicle(vehicle);

        // Create ticket
        int ticketId = nextTicketId++;

        auto ticket =
            make_unique<Ticket>(
                ticketId,
                vehicle,
                spot
            );

        Ticket* ticketPtr = ticket.get();

        activeTickets[ticketId] =
            move(ticket);

        cout << "Vehicle "
             << vehicle->getLicenseNumber()
             << " parked successfully.\n";

        cout << "Spot ID: "
             << spot->getId()
             << "\n";

        cout << "Ticket ID: "
             << ticketId
             << "\n";

        return ticketPtr;
    }

    // --------------------------------------------------------
    // Remove vehicle
    // --------------------------------------------------------

    double removeVehicle(
        int ticketId,
        PaymentType paymentType
    ) {

        auto it = activeTickets.find(ticketId);

        if (it == activeTickets.end()) {
            throw runtime_error("Invalid ticket");
        }

        Ticket* ticket = it->second.get();

        // Calculate fee
        double fee =
            feeStrategy->calculateFee(*ticket);

        cout << "Parking fee: ₹"
             << fee << "\n";

        // Payment
        auto payment =
            PaymentFactory::createPayment(paymentType);

        payment->pay(fee);

        // Free parking spot
        ParkingSpot* spot =
            ticket->getSpot();

        spot->removeVehicle();

        cout << "Vehicle "
             << ticket->getVehicle()->getLicenseNumber()
             << " removed successfully.\n";

        // Remove ticket
        activeTickets.erase(it);

        return fee;
    }
};


// ============================================================
// 10. MAIN
// ============================================================

int main() {

    // Create parking strategy
    auto parkingStrategy =
        make_unique<FirstAvailableStrategy>();

    // Create fee strategy
    auto feeStrategy =
        make_unique<HourlyFeeStrategy>(
            20,   // Bike
            40,   // Car
            60    // Truck
        );

    // Create parking lot
    ParkingLot parkingLot(
        move(parkingStrategy),
        move(feeStrategy)
    );

    // --------------------------------------------------------
    // Create floors
    // --------------------------------------------------------

    parkingLot.addFloor(1);
    parkingLot.addFloor(2);

    // --------------------------------------------------------
    // Add spots to floor 1
    // --------------------------------------------------------

    ParkingFloor* floor1 =
        parkingLot.getFloor(1);

    floor1->addSpot(101, SpotType::BIKE);
    floor1->addSpot(102, SpotType::CAR);
    floor1->addSpot(103, SpotType::CAR);
    floor1->addSpot(104, SpotType::TRUCK);

    // --------------------------------------------------------
    // Add spots to floor 2
    // --------------------------------------------------------

    ParkingFloor* floor2 =
        parkingLot.getFloor(2);

    floor2->addSpot(201, SpotType::BIKE);
    floor2->addSpot(202, SpotType::CAR);

    // --------------------------------------------------------
    // Create vehicles
    // --------------------------------------------------------

    Bike bike("TS01AB1234");
    Car car("TS02CD5678");
    Truck truck("TS03EF9999");

    // --------------------------------------------------------
    // Park vehicles
    // --------------------------------------------------------

    Ticket* bikeTicket =
        parkingLot.parkVehicle(&bike);

    Ticket* carTicket =
        parkingLot.parkVehicle(&car);

    Ticket* truckTicket =
        parkingLot.parkVehicle(&truck);

    // --------------------------------------------------------
    // Remove car
    // --------------------------------------------------------

    if (carTicket != nullptr) {

        parkingLot.removeVehicle(
            carTicket->getTicketId(),
            PaymentType::UPI
        );
    }

    return 0;
}
```

---

# 2. Don't memorize the code

The important thing is the **architecture**.

Our system is:

```text
                         ParkingLot
                             |
        ---------------------------------------------
        |                    |                      |
      Floors          ParkingStrategy           FeeStrategy
        |                    |                      |
      Spots          FirstAvailable          HourlyFee
        |
      Vehicle
      /  |  \
    Bike Car Truck


                         Ticket
                           |
                ---------------------
                |                   |
             Vehicle              Spot


                         Payment
                           |
              -------------------------
              |           |           |
             Cash        Card        UPI
                           ↑
                           |
                    PaymentFactory
```

---

# 3. Why did we create each class?

This is **exactly what you should be able to explain to Microsoft.**

### `Vehicle`

Represents a vehicle.

```cpp
Vehicle
 ├── Bike
 ├── Car
 └── Truck
```

We use inheritance because:

```text
Bike IS-A Vehicle
Car IS-A Vehicle
Truck IS-A Vehicle
```

---

### `ParkingSpot`

Responsible for:

```text
Is the spot free?
Can this vehicle fit?
Park vehicle
Remove vehicle
```

That's its responsibility.

---

### `ParkingFloor`

Responsible for:

```text
Floor number
Collection of parking spots
```

---

### `ParkingLot`

Coordinates the overall operation:

```text
Find spot
Park vehicle
Generate ticket
Remove vehicle
Calculate fee
Process payment
```

---

### `Ticket`

Stores parking-session information:

```text
Ticket ID
Vehicle
Spot
Entry time
```

---

# 4. Why `ParkingStrategy`?

This is where we use the **Strategy Pattern** you learned.

Today:

```text
FirstAvailableStrategy
```

Tomorrow interviewer says:

> "Find the nearest parking spot."

We can add:

```cpp
class NearestSpotStrategy : public ParkingStrategy {
    // ...
};
```

without changing the core parking logic.

So:

```text
ParkingLot
     |
     +---- ParkingStrategy
                |
        ------------------
        |                |
 FirstAvailable       Nearest
```

That's **Strategy + composition + polymorphism**.

---

# 5. Why `FeeStrategy`?

Same idea.

Today:

```text
HourlyFeeStrategy
```

Tomorrow:

```text
WeekendFeeStrategy
DynamicPricingStrategy
VehicleBasedFeeStrategy
```

All can implement:

```cpp
class FeeStrategy
```

Again, Strategy Pattern.

---

# 6. Why `Payment`?

Because payment has multiple implementations:

```text
Payment
  |
  +--- Cash
  +--- Card
  +--- UPI
```

We don't want:

```cpp
if (paymentType == "UPI")
    ...
else if (paymentType == "CARD")
    ...
```

inside the parking logic.

Instead:

```cpp
payment->pay(fee);
```

That's polymorphism.

---

# 7. Why `PaymentFactory`?

Someone needs to create:

```text
UPIPayment
CardPayment
CashPayment
```

So we use:

```cpp
PaymentFactory::createPayment(...)
```

This is the **Factory pattern**.

Remember:

```text
Strategy → how should I do it?

Factory → which object should I create?
```

---

# 8. Why `unique_ptr`?

You will see this a lot in good C++ LLD code:

```cpp
unique_ptr<ParkingSpot>
unique_ptr<Ticket>
unique_ptr<Payment>
```

The simple idea:

> `unique_ptr` means one owner is responsible for that object.

For example:

```cpp
vector<unique_ptr<ParkingSpot>> spots;
```

means the floor owns its parking spots.

When the floor is destroyed, the spots are automatically destroyed.

No:

```cpp
delete spot;
```

needed.

For your Microsoft interview, this is a **good modern C++ practice**.

---

# 9. One thing I'd change in a real interview

The code above is intentionally easy to learn, but there's one design issue worth discussing.

We currently have:

```cpp
Vehicle* vehicle;
```

and:

```cpp
Ticket
    Vehicle* vehicle;
```

These are **non-owning pointers**.

That's okay here because the `main()` owns:

```cpp
Bike bike;
Car car;
Truck truck;
```

and those objects live long enough.

In a production design, you'd explicitly discuss **ownership and lifetime**.

That's actually a good thing to mention if the interviewer asks.

---

# 10. The most important interview part

Suppose the interviewer asks:

> **"Why did you use Strategy Pattern?"**

Say:

> "Parking spot selection and fee calculation can have multiple algorithms. I don't want ParkingLot to contain a large set of conditionals or be tightly coupled to one algorithm, so I abstract them behind strategy interfaces."

---

If they ask:

> **"Why Factory?"**

Say:

> "Payment has multiple concrete implementations. The factory centralizes creation so the rest of the system doesn't need to know which concrete payment class to instantiate."

---

If they ask:

> **"Why inheritance for Vehicle?"**

Say:

> "Car, Bike and Truck are all vehicles, so this is a genuine IS-A relationship. It also allows the system to treat them polymorphically through the Vehicle interface."

---

If they ask:

> **"Why not make Car, Bike and Truck completely separate classes?"**

Say:

> "Because they share common vehicle properties and behavior, and the rest of the system often only needs to interact with them as a Vehicle."

---

# ⭐ Most important: how to build this yourself

Don't copy-paste the code and think you've learned Parking Lot.

Try implementing it yourself in this order:

```text
1. Vehicle
      ↓
2. Bike / Car / Truck
      ↓
3. ParkingSpot
      ↓
4. ParkingFloor
      ↓
5. Ticket
      ↓
6. ParkingLot
      ↓
7. Payment
      ↓
8. PaymentFactory
      ↓
9. ParkingStrategy
      ↓
10. FeeStrategy
```

If you can build that **without looking at the solution**, you're starting to understand LLD.

And don't worry if the first implementation takes you an hour. That's normal.

## Next: Tic-Tac-Toe

Parking Lot is relatively large. **Tic-Tac-Toe** is much smaller and is a great exercise for learning the most important LLD skill:

> **Don't overengineer a simple problem.**

We'll design it together first, then I'll give you the complete C++ code and show you what an interviewer can change mid-interview.
